/**
 * Run Events Client — streams a cloud run's live progress into the terminal.
 *
 * Mirrors the backend's actual fan-out path (`src/adapters/socketio/server.py` +
 * `handlers/run_progress.py`, backend repo): the worker XADDs step/status/issue events onto a
 * per-run Redis Stream as it goes, and `RunProgressBroker` tails that stream into the Socket.IO
 * room `run:{run_id}` once a client `join_run`s and is authorized. This is the same live-progress
 * feed the web dashboard's run page subscribes to (`frontend/src/lib/socket.ts`) — the CLI just
 * renders it as terminal lines instead of a UI, and skips `run.frame` (base64 CDP screencast
 * frames) entirely since there's no terminal use for raw video frames.
 *
 * Auth: the connection-level handshake (`auth.token`) is the CLI's own `tb_live_`-prefixed API
 * key, verified the same way as every other CLI→backend call — no separate `cli_auth` step is
 * needed here (that one's specific to the mobile Appium bridge's device-command relay).
 */

import { io, type Socket } from 'socket.io-client';
import type { UIService } from '../ui/ui.types.js';

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

/**
 * Join a run's live progress room and print each event as it arrives.
 *
 * Resolves once the run reaches a terminal state (`run.completed`) or the caller aborts (Ctrl+C
 * sets `signal`'s abort). Never rejects on a mid-run hiccup — a dropped/degraded event stream
 * still lets the run itself finish server-side, so this only surfaces a warning and keeps
 * waiting, the same "don't kill the whole watch over one bad message" posture as the backend
 * broker's own per-iteration retry.
 */
export async function watchRun(
  apiBaseUrl: string,
  authToken: string,
  runId: string,
  ui: UIService,
  signal?: AbortSignal,
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

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.emit('leave_run', { run_id: runId });
      socket.disconnect();
      resolve();
    };

    signal?.addEventListener('abort', finish);

    socket.on('connect', () => {
      socket.emit('join_run', { run_id: runId });
    });

    socket.on('connect_error', (err: Error) => {
      ui.warn(`Live stream connection issue: ${err.message}`);
    });

    socket.on('run.error', (data: { error?: string }) => {
      ui.warn(`Could not watch this run live: ${data.error ?? 'not authorized'}`);
      finish();
    });

    socket.on('run.status_changed', (data: RunStatusEvent) => {
      ui.info(`Status → ${data.new_status}`);
    });

    socket.on('run.step_started', (data: RunStepStartedEvent) => {
      const action = data.title || data.action || 'next action';
      ui.info(`🤖 Agent — step ${data.step_number + 1}: ${action}`);
      if (data.reasoning) ui.hint(`Reasoning: ${data.reasoning}`);
      if (data.description && data.description !== data.reasoning) {
        ui.hint(`Details: ${data.description}`);
      }
    });

    socket.on('run.step_result', (data: RunStepResultEvent) => {
      const detail = data.detail || data.error || data.outcome || 'completed';
      if (data.outcome === 'failure' || data.error) {
        ui.warn(`Step ${data.step_number + 1}: ${detail}`);
      } else {
        ui.info(`Step ${data.step_number + 1}: ${detail}`);
      }
    });

    socket.on('run.step_completed', (data: RunStepEvent) => {
      const label = data.title || data.description || data.action || 'step';
      const target = data.ref ? ` → ${data.ref}` : '';
      if (data.error) {
        ui.warn(`Step ${data.step_number}: ${label}${target} — ${data.error}`);
      } else {
        ui.info(`Step ${data.step_number}: ${label}${target}`);
      }
    });

    socket.on('run.issue_detected', (data: RunIssueEvent) => {
      ui.warn(`Issue [${data.severity}] ${data.title}`);
    });

    socket.on('run.report_ready', (data: RunReportEvent) => {
      if (data.summary_title) ui.info(`Summary: ${data.summary_title}`);
    });

    socket.on('run.completed', (data: RunCompletedEvent) => {
      const status = data.final_status.toUpperCase();
      if (status === 'PASSED') {
        ui.success(`Run completed: ${status}`);
      } else {
        ui.warn(`Run completed: ${status}`);
      }
      finish();
    });
  });
}
