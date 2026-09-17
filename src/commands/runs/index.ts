/**
 * Runs command — inspect past and in-progress test runs, view details, and re-run.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { getContext as GetContextFn } from '../../cli.js';
import type { CliContext } from '../../types/context.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';

type ContextGetter = typeof GetContextFn;

export interface TestRun {
  id: string;
  run_id?: string;
  test_id?: string;
  test_name?: string;
  name?: string;
  goal?: string;
  status: string;
  environment?: string;
  created_at?: string;
  duration_seconds?: number;
  trigger_type?: string;
  error?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps?: Array<any>;
}

export function registerRunsCommands(program: Command, getContext: ContextGetter): void {
  const runs = program
    .command('runs')
    .description('Inspect past test runs and execution history')
    .option('--json', 'Output runs as JSON')
    .argument('[runId]', 'Optional specific Run ID to inspect')
    .action(async function (this: Command, runId?: string, options?: { json?: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      const config = await ctx.infra.config.loadGlobalConfig();
      const workspaceId = config.workspaceId;
      if (!workspaceId) {
        ctx.infra.ui.warn('No workspace selected. Run `traceback workspaces` first.');
        return;
      }

      if (runId) {
        await showRunDetail(ctx, workspaceId, runId, options?.json);
        return;
      }

      await listAndInspectRuns(ctx, workspaceId, options?.json);
    });

  runs
    .command('get <id>')
    .description('Get detailed execution report for a run')
    .option('--json', 'Output as JSON')
    .action(async function (this: Command, id: string, options?: { json?: boolean }) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      const config = await ctx.infra.config.loadGlobalConfig();
      const workspaceId = config.workspaceId;
      if (!workspaceId) {
        ctx.infra.ui.warn('No workspace selected. Run `traceback workspaces` first.');
        return;
      }

      await showRunDetail(ctx, workspaceId, id, options?.json);
    });
}

async function listAndInspectRuns(
  ctx: CliContext,
  workspaceId: string,
  isJson?: boolean,
): Promise<void> {
  const ui = ctx.infra.ui;
  const spinner = ui.spinner('Fetching test run history...');
  let runs: TestRun[] = [];

  try {
    const result = await ctx.infra.api.get<TestRun[]>(`/api/v1/workspaces/${workspaceId}/runs`);
    runs = result.data || [];
    spinner.stop();
  } catch (err: unknown) {
    spinner.fail('Failed to fetch runs');
    // If endpoint is not found, fallback gracefully
    if (
      err &&
      typeof err === 'object' &&
      'response' in err &&
      (err as { response?: { status?: number } }).response?.status === 404
    ) {
      ui.hint('No run history available for this workspace yet.');
      return;
    }
    throw err;
  }

  if (isJson || ui.isJsonMode()) {
    ui.renderJson(runs);
    return;
  }

  if (!runs.length) {
    ui.info('No test runs found in this workspace.');
    ui.hint('Run your first test with `traceback tests`!');
    return;
  }

  const tableHeaders = ['Status', 'Test Name', 'Run ID', 'Env', 'Duration', 'Trigger'];
  const tableRows = runs.slice(0, 10).map((r) => {
    const id = r.run_id || r.id;
    const name = r.test_name || r.name || r.goal?.slice(0, 30) || 'Ad-hoc Run';
    const status = (r.status || 'unknown').toUpperCase();
    const statusBadge =
      status === 'PASSED'
        ? chalk.green('✔ PASSED')
        : status === 'FAILED'
          ? chalk.red('✖ FAILED')
          : chalk.cyan(`● ${status}`);
    const dur = r.duration_seconds ? `${r.duration_seconds.toFixed(1)}s` : '—';
    const env = r.environment || 'production';
    const trigger = r.trigger_type || 'CLI';

    return [statusBadge, name, id.slice(0, 12) + '...', env, dur, trigger];
  });

  ui.table(tableHeaders, tableRows);

  if (process.stdin.isTTY && !ui.isSilent()) {
    const { select } = await import('@inquirer/prompts');
    const selectedRunId = await select({
      message: 'Select a run to inspect details',
      choices: [
        ...runs.slice(0, 10).map((r) => {
          const id = r.run_id || r.id;
          const name = r.test_name || r.name || r.goal?.slice(0, 40) || 'Ad-hoc Run';
          const status = (r.status || 'unknown').toUpperCase();
          const icon = status === 'PASSED' ? '✔' : status === 'FAILED' ? '✖' : '●';
          return {
            name: `${icon}  ${name}  (${id.slice(0, 10)}...)`,
            value: id,
          };
        }),
        { name: chalk.dim('← Back / Exit'), value: '__exit__' },
      ],
    });

    if (selectedRunId !== '__exit__') {
      await showRunDetail(ctx, workspaceId, selectedRunId, false);
    }
  }
}

async function showRunDetail(
  ctx: CliContext,
  workspaceId: string,
  runId: string,
  isJson?: boolean,
): Promise<void> {
  const ui = ctx.infra.ui;
  const spinner = ui.spinner(`Fetching details for run ${runId}...`);
  let run: TestRun;

  try {
    const result = await ctx.infra.api.get<TestRun>(
      `/api/v1/workspaces/${workspaceId}/runs/${runId}`,
    );
    run = result.data;
    spinner.stop();
  } catch (error) {
    spinner.fail(`Failed to fetch run ${runId}`);
    throw error;
  }

  if (isJson || ui.isJsonMode()) {
    ui.renderJson(run);
    return;
  }

  const status = (run.status || 'UNKNOWN').toUpperCase();
  const statusBadge =
    status === 'PASSED'
      ? ui.badge('PASSED', 'success')
      : status === 'FAILED'
        ? ui.badge('FAILED', 'error')
        : ui.badge(status, 'brand');

  const testTitle = run.test_name || run.name || run.goal || 'Test Run';
  const duration = run.duration_seconds ? `${run.duration_seconds.toFixed(1)}s` : 'N/A';
  const reportUrl = `https://traceback.dev/runs/${runId}`;

  ui.box(
    `${chalk.hex('#6366F1').bold('🧪 ' + testTitle)}\n\n` +
      `  ${chalk.dim('Run ID:')}      ${chalk.cyan(runId)}\n` +
      `  ${chalk.dim('Status:')}      ${statusBadge}\n` +
      `  ${chalk.dim('Environment:')} ${chalk.white(run.environment || 'production')}\n` +
      `  ${chalk.dim('Duration:')}    ${chalk.white(duration)}\n` +
      `  ${chalk.dim('Trigger:')}     ${chalk.white(run.trigger_type || 'CLI')}\n` +
      `  ${chalk.dim('Report Web:')}  ${chalk.white(reportUrl)}`,
    { title: 'Test Run Details', borderColor: status === 'PASSED' ? 'green' : 'red' },
  );

  if (run.error) {
    ui.errorCard('Run Failure Reason', run.error, [
      `Inspect detailed step logs at ${reportUrl}`,
      'Run `traceback tests` to execute this test locally in your browser',
    ]);
  }
}
