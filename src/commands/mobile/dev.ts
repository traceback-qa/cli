/**
 * `traceback mobile dev` / `traceback mobile test` — Mode 1: a persistent cloud emulator with
 * a live-reload tunnel, instead of the provision/install/test/teardown cycle `mobile verify`
 * (and every queue-dispatched run) pays every single time.
 *
 * `mobile dev` starts the session: spawns (or reuses) `expo start --tunnel`, captures the
 * printed public tunnel URL, and POSTs it straight to the backend's
 * `POST /mobile-sessions` as plain JSON — no WebSocket signaling needed here the way the CDP
 * tunnel (`tunnel.client.ts`) needs one. A CDP URL is normally localhost-only, so the backend
 * worker needs a maintained connection to reach back through; `expo start --tunnel`'s URL is
 * already a public HTTPS address the backend can just use directly.
 *
 * `mobile test` runs one goal against whatever session is currently live for the workspace and
 * prints a link to the *existing* run-viewer page (`/runs/initializing?session_id=...`) — a
 * Mode-1 test still creates a real `TestRun` row server-side, so nothing new was needed on the
 * frontend for this to just work.
 */

import type { Command } from 'commander';
import type { CliContext } from '../../types/context.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';
import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

type ContextGetter = (cmd: Command) => CliContext | undefined;

// Metro's own status endpoint — `GET /status` on the bundler port replies "packager-status:running"
// when a dev server is already up. Default RN/Expo port; not configurable via a flag here since
// neither RN nor Expo commonly runs it anywhere else.
const METRO_STATUS_URL = 'http://localhost:8081/status';

// Matches either an `exp://` deep link or a plain `https://` URL — Expo's CLI prints one of these
// once `--tunnel` establishes (exact wording isn't documented anywhere public; this is the one
// piece of this feature that needs live verification against real `expo start --tunnel` output,
// same as the EAS GraphQL schema needed live iteration earlier — fix the regex against the real
// printed line if it doesn't match, rather than guessing further).
const TUNNEL_URL_REGEX =
  /(exp:\/\/[^\s]+|https:\/\/[^\s]+\.exp\.direct[^\s]*|https:\/\/[^\s]*ngrok[^\s]*)/;

const TUNNEL_DETECT_TIMEOUT_MS = 60_000;

async function isMetroRunning(): Promise<boolean> {
  try {
    const res = await fetch(METRO_STATUS_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resolve the workspace id the same way `traceback workspaces` persists it — NOT the broken
 * `ctx.activeWorkspaceId` cast `mobile verify` uses (dead code, no such field on CliContext). */
async function resolveWorkspaceId(
  ctx: CliContext,
  explicit: string | undefined,
): Promise<string | null> {
  if (explicit) return explicit;
  const config = await ctx.infra.config.loadGlobalConfig();
  return config.workspaceId ?? null;
}

function spawnExpoTunnel(
  ui: CliContext['infra']['ui'],
): Promise<{ child: ChildProcessByStdio<null, Readable, Readable>; tunnelUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['expo', 'start', '--tunnel'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<null, Readable, Readable>;

    let resolved = false;
    let buffer = '';

    const onOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      buffer += text;
      ui.debug(text.trimEnd());
      const match = TUNNEL_URL_REGEX.exec(buffer);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ child, tunnelUrl: match[1]! });
      }
    };

    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    child.on('error', (err) => {
      if (!resolved) reject(new Error(`Failed to start Expo: ${err.message}`));
    });
    child.on('exit', (code) => {
      if (!resolved) {
        reject(
          new Error(
            `Expo exited (code ${code}) before printing a tunnel URL. Last output:\n${buffer.slice(-500)}`,
          ),
        );
      }
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(
          new Error(
            `Timed out waiting for Expo's tunnel URL after ${TUNNEL_DETECT_TIMEOUT_MS / 1000}s. ` +
              `Last output:\n${buffer.slice(-500)}`,
          ),
        );
      }
    }, TUNNEL_DETECT_TIMEOUT_MS);
  });
}

export function registerMobileDevCommands(mobile: Command, getContext: ContextGetter): void {
  mobile
    .command('dev')
    .description(
      'Start a persistent cloud emulator with a live-reload tunnel to your local Expo dev\n' +
        'server — the device stays up across every `mobile test` call instead of a fresh\n' +
        'provision+install per run. Ctrl+C to stop and release the device.',
    )
    .requiredOption('-a, --app <buildName>', 'Mobile build name to install (from Toolbox)')
    .option('--workspace <id>', 'Workspace ID (defaults to current)')
    .option('--tunnel-url <url>', 'Already-running Expo tunnel URL — skip auto-start')
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;
      await createRequireAuthMiddleware(ctx)();

      const { api, ui } = ctx.infra;
      const workspaceId = await resolveWorkspaceId(ctx, options['workspace']);
      if (!workspaceId) {
        ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
        return;
      }

      let expoChild: ChildProcessByStdio<null, Readable, Readable> | null = null;
      let bundlerUrl: string | undefined = options['tunnelUrl'];

      if (!bundlerUrl) {
        if (await isMetroRunning()) {
          ui.warn(
            'A local Metro/Expo dev server is already running on :8081, but not necessarily with\n' +
              '--tunnel. Pass --tunnel-url <url> if you already have one, or stop it and let this\n' +
              'command start its own.',
          );
          return;
        }
        const spinner = ui.spinner('Starting Expo with a tunnel...');
        try {
          const { child, tunnelUrl } = await spawnExpoTunnel(ui);
          expoChild = child;
          bundlerUrl = tunnelUrl;
          spinner.succeed(`Tunnel ready: ${tunnelUrl}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- error shape not modeled
        } catch (err: any) {
          spinner.fail(err.message);
          return;
        }
      }

      const sessionSpinner = ui.spinner('Starting the persistent device session...');
      let sessionId: string;
      let streamUrl: string | null = null;
      try {
        const res = await api.post<{
          session_id?: string;
          stream_url?: string | null;
          error?: string;
        }>(`/api/v1/workspaces/${workspaceId}/mobile-sessions`, {
          mobile_app_id: options['app'],
          bundler_url: bundlerUrl,
        });
        if (res.data.error || !res.data.session_id) {
          sessionSpinner.fail(`Failed to start session: ${res.data.error ?? 'unknown error'}`);
          expoChild?.kill();
          return;
        }
        sessionId = res.data.session_id;
        streamUrl = res.data.stream_url ?? null;
        sessionSpinner.succeed('Device is live and tunneled');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
      } catch (err: any) {
        sessionSpinner.fail(`Failed to start session: ${err.message}`);
        expoChild?.kill();
        return;
      }

      ui.info('');
      ui.info(`Session ${sessionId} is live. Save a file — changes should appear in ~2s.`);
      if (streamUrl) ui.info(`Watch it: ${streamUrl}`);
      ui.info('Run tests against it from another terminal with:');
      ui.info(`  traceback mobile test -g "<goal>" --workspace ${workspaceId}`);
      ui.info('\nPress Ctrl+C to stop.\n');

      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          ui.info('\nStopping...');
          resolve();
        });
      });

      const stopSpinner = ui.spinner('Releasing the device...');
      try {
        await api.delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`);
        stopSpinner.succeed('Device released');
      } catch {
        stopSpinner.warn(
          'Could not confirm the device was released — it will idle-timeout on its own.',
        );
      }
      expoChild?.kill();
    });

  mobile
    .command('test')
    .description('Run one goal against the currently-live `mobile dev` session.')
    .requiredOption('-g, --goal <text>', 'Natural-language test goal')
    .option('--workspace <id>', 'Workspace ID (defaults to current)')
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;
      await createRequireAuthMiddleware(ctx)();

      const { api, ui } = ctx.infra;
      const workspaceId = await resolveWorkspaceId(ctx, options['workspace']);
      if (!workspaceId) {
        ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
        return;
      }

      const statusSpinner = ui.spinner('Looking for a live session...');
      let sessionId: string;
      try {
        const status = await api.get<{ active: boolean; session_id?: string }>(
          `/api/v1/workspaces/${workspaceId}/mobile-sessions`,
        );
        if (!status.data.active || !status.data.session_id) {
          statusSpinner.fail('No live session — run `traceback mobile dev` first.');
          return;
        }
        sessionId = status.data.session_id;
        statusSpinner.succeed('Found a live session');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
      } catch (err: any) {
        statusSpinner.fail(`Failed to check session status: ${err.message}`);
        return;
      }

      const runSpinner = ui.spinner('Running against the live device...');
      try {
        const res = await api.post<{ run_id?: string; status?: string; error?: string }>(
          `/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}/test`,
          { goal: options['goal'] },
        );
        if (res.data.error || !res.data.run_id) {
          runSpinner.fail(`Run failed: ${res.data.error ?? 'unknown error'}`);
          return;
        }
        runSpinner.succeed(`${res.data.status} — run ${res.data.run_id}`);
        ui.info(
          `View it in your dashboard: Runs > find run_id ${res.data.run_id}\n` +
            "(no direct link here — this CLI has no config for the dashboard's own URL yet)",
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled
      } catch (err: any) {
        runSpinner.fail(`Run failed: ${err.message}`);
      }
    });
}
