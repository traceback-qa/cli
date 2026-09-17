/**
 * Run Events Client — streams a cloud run's live progress into the terminal.
 *
 * Supports two rendering modes:
 * 1. Split-Pane Live TUI Dashboard (interactive terminal sessions)
 * 2. Hierarchical Step Stream (CI / non-TTY / pipe fallback)
 */

import { io, type Socket } from 'socket.io-client';
import chalk from 'chalk';
import type { UIService, SpinnerHandle } from '../ui/ui.types.js';
import { TuiDashboard } from '../ui/dashboard/tui.dashboard.js';

interface RunStepEvent {
  step_number: number;
  action?: string;
  ref?: string | null;
  title?: string | null;
  description?: string | null;
  error?: string | null;
}

interface RunIssueEvent {
  source: string;
  severity: string;
  title: string;
}

interface RunStepStartedEvent {
  step_number: number;
  action?: string;
  title?: string | null;
  description?: string | null;
  reasoning?: string | null;
}

interface RunStepResultEvent {
  step_number: number;
  outcome?: string;
  detail?: string | null;
  error?: string | null;
}

interface RunStatusEvent {
  new_status: string;
}

interface RunReportEvent {
  summary_title?: string;
  summary?: string;
}

interface RunCompletedEvent {
  final_status: string;
}

export interface WatchRunOptions {
  testName?: string;
  environment?: string;
  targetName?: string;
  enableDashboard?: boolean;
}

/**
 * Join a run's live progress room and stream each event live.
 */
export async function watchRun(
  apiBaseUrl: string,
  authToken: string,
  runId: string,
  ui: UIService,
  signal?: AbortSignal,
  options?: WatchRunOptions,
): Promise<void> {
  const socketUrl = apiBaseUrl.replace(/\/api\/v1$/, '');
  const socket: Socket = io(socketUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: authToken },
    query: { token: authToken },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 30_000,
  });

  const useDashboard =
    options?.enableDashboard !== false &&
    Boolean(process.stdout.isTTY) &&
    !ui.isJsonMode() &&
    !ui.isSilent();

  let dashboard: TuiDashboard | null = null;

  await new Promise<void>((resolve) => {
    let settled = false;
    let showReasoning = true;
    let activeStepSpinner: SpinnerHandle | null = null;
    let activeStepNumber: number | null = null;
    let stepStartTime: number = Date.now();

    const cleanup = (): void => {
      if (dashboard) {
        dashboard.stop();
        dashboard = null;
      }
      if (activeStepSpinner) {
        activeStepSpinner.stop();
        activeStepSpinner = null;
      }
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.emit('leave_run', { run_id: runId });
      socket.disconnect();
      resolve();
    };

    signal?.addEventListener('abort', finish);

    if (useDashboard) {
      dashboard = new TuiDashboard({
        runId,
        testName: options?.testName || 'Live Test Run',
        environment: options?.environment || 'production',
        targetName: options?.targetName || 'Browser Session',
        onDetach: finish,
      });
      dashboard.start();
    } else {
      // Non-dashboard interactive key listener fallback
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        const onKeypress = (data: Buffer): void => {
          const key = data.toString();
          if (key === 'q' || key === '\u0003') {
            ui.info('\nDetached from live run stream.');
            finish();
          } else if (key.toLowerCase() === 'v') {
            showReasoning = !showReasoning;
            ui.hint(
              `Agent reasoning output: ${showReasoning ? chalk.green('ON') : chalk.gray('OFF')}`,
            );
          }
        };

        try {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.on('data', onKeypress);
        } catch {
          // ignore
        }
      }
    }

    socket.on('connect', () => {
      socket.emit('join_run', { run_id: runId });
    });

    socket.on('connect_error', (err: Error) => {
      if (dashboard) {
        dashboard.addIssue({
          severity: 'warn',
          title: `Stream connection issue: ${err.message}`,
          source: 'socket',
          timestamp: Date.now(),
        });
      } else {
        ui.warn(`Live stream connection issue: ${err.message}`);
      }
    });

    socket.on('run.error', (data: { error?: string }) => {
      if (dashboard) {
        dashboard.stop();
      }
      ui.warn(`Could not watch this run live: ${data.error ?? 'not authorized'}`);
      finish();
    });

    socket.on('run.status_changed', (data: RunStatusEvent) => {
      if (dashboard) {
        dashboard.setStatus(data.new_status);
      } else {
        if (activeStepSpinner) {
          activeStepSpinner.stop();
          activeStepSpinner = null;
        }
        const statusUpper = data.new_status.toUpperCase();
        if (statusUpper === 'RUNNING') {
          ui.info(`${chalk.green('●')} Live agent execution in progress...`);
        } else {
          ui.info(`Run status: ${chalk.bold.cyan(statusUpper)}`);
        }
      }
    });

    socket.on('run.step_started', (data: RunStepStartedEvent) => {
      const stepNum = data.step_number + 1;
      const action = data.title || data.action || 'Executing action...';

      if (dashboard) {
        dashboard.startStep(stepNum, action, data.reasoning);
      } else {
        if (activeStepSpinner) {
          activeStepSpinner.stop();
        }

        activeStepNumber = stepNum;
        stepStartTime = Date.now();

        if (!ui.isJsonMode() && !ui.isSilent()) {
          activeStepSpinner = ui.spinner(
            `${chalk.cyan(`Step ${activeStepNumber}:`)} ${chalk.white(action)}`,
          );
        }

        if (showReasoning && data.reasoning) {
          if (activeStepSpinner) {
            activeStepSpinner.stop();
          }
          ui.hint(
            `  ${chalk.gray('└─')} ${chalk.cyan('🤖 Reasoning:')} ${chalk.dim(data.reasoning)}`,
          );
          if (activeStepSpinner) {
            activeStepSpinner.start();
          }
        }
      }
    });

    socket.on('run.step_result', (data: RunStepResultEvent) => {
      const stepNum = data.step_number + 1;
      const detail = data.detail || data.error || data.outcome || 'completed';
      const outcome = data.outcome || (data.error ? 'failure' : 'success');

      if (dashboard) {
        dashboard.completeStep(stepNum, outcome, detail, data.error);
      } else {
        const elapsed = ((Date.now() - stepStartTime) / 1000).toFixed(1);
        const stepLabel = `Step ${stepNum}`;

        if (activeStepSpinner) {
          if (outcome === 'failure' || data.error) {
            activeStepSpinner.fail(
              `${chalk.red(stepLabel)}: ${detail} ${chalk.dim(`[${elapsed}s]`)}`,
            );
          } else {
            activeStepSpinner.succeed(
              `${chalk.green(stepLabel)}: ${detail} ${chalk.dim(`[${elapsed}s]`)}`,
            );
          }
          activeStepSpinner = null;
        } else {
          if (outcome === 'failure' || data.error) {
            ui.warn(`${stepLabel}: ${detail} [${elapsed}s]`);
          } else {
            ui.info(`${stepLabel}: ${detail} [${elapsed}s]`);
          }
        }
      }
    });

    socket.on('run.step_completed', (data: RunStepEvent) => {
      const label = data.title || data.description || data.action || 'step';
      const target = data.ref ? ` → ${data.ref}` : '';
      const fullTitle = `${label}${target}`;

      if (dashboard) {
        dashboard.completeStep(
          data.step_number,
          data.error ? 'failure' : 'success',
          fullTitle,
          data.error,
        );
      } else if (activeStepSpinner) {
        const elapsed = ((Date.now() - stepStartTime) / 1000).toFixed(1);
        if (data.error) {
          activeStepSpinner.fail(
            `Step ${data.step_number}: ${fullTitle} — ${data.error} ${chalk.dim(`[${elapsed}s]`)}`,
          );
        } else {
          activeStepSpinner.succeed(
            `Step ${data.step_number}: ${fullTitle} ${chalk.dim(`[${elapsed}s]`)}`,
          );
        }
        activeStepSpinner = null;
      }
    });

    socket.on('run.issue_detected', (data: RunIssueEvent) => {
      if (dashboard) {
        dashboard.addIssue({
          severity: data.severity,
          title: data.title,
          source: data.source,
          timestamp: Date.now(),
        });
      } else {
        if (activeStepSpinner) {
          activeStepSpinner.stop();
        }
        const sevBadge =
          data.severity.toLowerCase() === 'high' || data.severity.toLowerCase() === 'critical'
            ? ui.badge(data.severity.toUpperCase(), 'error')
            : ui.badge(data.severity.toUpperCase(), 'warn');

        ui.warn(` ${sevBadge} ${chalk.bold(data.title)} ${chalk.dim(`(${data.source})`)}`);
        if (activeStepSpinner) {
          activeStepSpinner.start();
        }
      }
    });

    socket.on('run.report_ready', (data: RunReportEvent) => {
      if (dashboard) {
        dashboard.setReport(data.summary || data.summary_title || '');
      } else {
        if (activeStepSpinner) {
          activeStepSpinner.stop();
          activeStepSpinner = null;
        }
        if (data.summary_title || data.summary) {
          ui.box(`${chalk.bold(data.summary_title || 'Run Report')}\n\n${data.summary || ''}`, {
            title: '📊 Summary',
            borderColor: 'blue',
          });
        }
      }
    });

    socket.on('run.completed', (data: RunCompletedEvent) => {
      const status = data.final_status.toUpperCase();
      if (dashboard) {
        dashboard.setFinalStatus(status);
        // Let user see final dashboard state briefly before exiting
        setTimeout(() => {
          cleanup();
          renderFinalSummary(ui, status, runId);
          finish();
        }, 1200);
      } else {
        if (activeStepSpinner) {
          activeStepSpinner.stop();
          activeStepSpinner = null;
        }
        renderFinalSummary(ui, status, runId);
        finish();
      }
    });
  });
}

function renderFinalSummary(ui: UIService, status: string, runId: string): void {
  if (status === 'PASSED') {
    ui.box(
      `${chalk.green.bold('✔ TEST RUN PASSED')}\n\n` +
        `  ${chalk.dim('Run ID:')}  ${chalk.cyan(runId)}\n` +
        `  ${chalk.dim('Status:')}  ${ui.badge('PASSED', 'success')}\n` +
        `  ${chalk.dim('Report:')}  ${chalk.white(`https://traceback.dev/runs/${runId}`)}`,
      { title: 'Result', borderColor: 'green' },
    );
  } else {
    ui.box(
      `${chalk.red.bold('✖ TEST RUN FAILED')}\n\n` +
        `  ${chalk.dim('Run ID:')}  ${chalk.cyan(runId)}\n` +
        `  ${chalk.dim('Status:')}  ${ui.badge(status, 'error')}\n` +
        `  ${chalk.dim('Report:')}  ${chalk.white(`https://traceback.dev/runs/${runId}`)}`,
      { title: 'Result', borderColor: 'red' },
    );
  }
}
