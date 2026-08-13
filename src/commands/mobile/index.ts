/**
 * `traceback mobile verify` — one-flag mobile verification through the relay tunnel.
 *
 * One command, one shot: create a relay session, attach this machine as the agent,
 * register the local Appium server as the session's device, and let the CLOUD engine
 * drive the device through the tunnel while it verifies a natural-language goal.
 *
 * The flow (all inside this command):
 *
 *   1. `POST /mobile-sessions` — a session for this workspace (or reuse the active one
 *      with `--reuse`).
 *   2. Attach as the relay agent (`RelayAgentClient`) so the backend can reach back
 *      into this machine — this is the tunnel half.
 *   3. `PATCH /mobile-sessions/{id}/device` — tell the backend the session's device is
 *      the local Appium server (`appium_url`, default http://localhost:4723). This is
 *      what lets `verify-mobile` adopt the *live* device instead of provisioning one.
 *   4. `POST .../mcp/verify-mobile` with `session_id` — the cloud engine drives the
 *      screen through the tunnel (tap/type/swipe/verify) until the goal is achieved
 *      or fails, then returns the verdict.
 *   5. Render the verdict; tear the session down (or keep the tunnel live with `--keep`
 *      for the edit -> hot-reload -> verify loop).
 *
 * `mobile dev` / `mobile test` (the persistent cloud-emulator mode) are registered as
 * siblings in `dev.ts` and unchanged.
 */

import type { Command } from 'commander';
import type { CliContext } from '../../types/context.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';
import { RelayAgentClient, type RelayReadyInfo } from '../../infrastructure/tunnel/relay/index.js';
import { resolveVerifyDevice } from '../../infrastructure/mobile/device.picker.js';
import { startScrcpyAgent, type ScrcpyAgent } from '../../infrastructure/mobile/scrcpy-agent.js';
import { registerMobileDevCommands } from './dev.js';

type ContextGetter = (cmd: Command) => CliContext | undefined;

const DEFAULT_APPIUM_URL = 'http://localhost:4723';
const DEFAULT_APPIUM_PORT = 4723;
const DEFAULT_LOCAL_URL = 'http://localhost:8081';
// verify-mobile runs the full agent loop (up to 15 LLM steps, each up to ~1 min).
// The API client's default 30s timeout would kill a legit in-flight verify.
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;

interface VerifyStep {
  status: string;
  description: string;
  failure_reason?: string | null;
}

interface VerifyVerdict {
  status: string;
  passed: boolean;
  run_id?: string | null;
  steps_passed: number;
  steps_total: number;
  duration_ms: number;
  steps?: VerifyStep[];
  summary?: string | null;
  video_url?: string | null;
  message?: string | null;
}

interface VerifyOptions {
  goal: string;
  platform?: string;
  appiumUrl?: string;
  udid?: string;
  localUrl?: string;
  port?: string;
  keep?: boolean;
  reuse?: boolean;
  workspace?: string;
}

export function registerMobileCommands(program: Command, getContext: ContextGetter): void {
  const mobile = program
    .command('mobile')
    .description('Mobile app verification — cloud-driven AI testing against a connected device');

  // `dev`/`test` — Mode 1: a persistent cloud emulator + live-reload tunnel, registered as
  // siblings of `verify` below rather than folded into it (different lifecycle entirely: one
  // long-lived foreground session instead of a single provision-run-teardown call).
  registerMobileDevCommands(mobile, getContext);

  mobile
    .command('verify')
    .description(
      'One-shot verification: open a relay tunnel to your local device and let the cloud\n' +
        'engine drive it against a natural-language goal. Requires a local Appium server\n' +
        'running (default http://localhost:4723) with your app/simulator attached.',
    )
    .requiredOption('-g, --goal <text>', 'Natural-language verification goal')
    .option('-p, --platform <platform>', 'Platform: android or ios', 'android')
    .option(
      '--appium-url <url>',
      'Your local Appium server URL',
      DEFAULT_APPIUM_URL,
    )
    .option(
      '--udid <udid>',
      'Device UDID to run the test against (auto-detected, or prompted when ambiguous)',
    )
    .option(
      '--local-url <url>',
      'Local dev server URL the tunnel forwards HTTP to (default http://localhost:8081)',
    )
    .option('--port <port>', 'Shorthand for --local-url http://localhost:<port>')
    .option(
      '--keep',
      'Keep the tunnel + session alive after the verdict (for the edit→reload→verify loop)',
    )
    .option(
      '--reuse',
      "Reuse the workspace's active session instead of creating a new one",
    )
    .option('-w, --workspace <id>', 'Workspace ID (defaults to current)')
    .action(async function (this: Command, options: VerifyOptions) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      const { api, ui } = ctx.infra;

      const workspaceId = await resolveWorkspaceId(ctx, options.workspace);
      if (!workspaceId) {
        ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
        return;
      }

      const platform = options.platform ?? 'android';
      if (platform !== 'android' && platform !== 'ios') {
        ui.error(`Unsupported platform: ${platform} — use android or ios`);
        return;
      }

      const appiumUrl = options.appiumUrl ?? DEFAULT_APPIUM_URL;
      const localUrl =
        options.localUrl ?? (options.port ? `http://localhost:${options.port}` : DEFAULT_LOCAL_URL);

      // iOS has no cloud provisioning — the engine always drives a booted Simulator on
      // this machine, and Appium's XCUITest driver MUST be told which one, so the target
      // device is always resolved up front — never left to Appium's guessing.
      // Resolve which device this run targets. An explicit --udid wins; otherwise a
      // single detected device is auto-selected, several prompt the user to pick one,
      // and zero fails fast with guidance. Previously only iOS had any of this —
      // Android let Appium silently pick "the sole attached device" or fail opaquely
      // when several were connected.
      const device = await resolveVerifyDevice({
        platform,
        explicitId: options.udid,
        flagName: '--udid',
        interactive: !ui.isJsonMode() && !ui.isSilent(),
        ui,
      });
      if (!device) return;
      const udid = device.id;

      // ── 1. Create (or reuse) the relay session ─────────────────────────
      let sessionId: string;
      let sessionUrl: string | null = null;
      let proxyPath: string | null = null;
      let deviceToken: string | null = null;

      const sessionSpinner = ui.spinner(
        options.reuse ? 'Looking for an active session...' : 'Creating relay session...',
      );
      try {
        if (options.reuse) {
          const status = await api.get<{
            active: boolean;
            session_id?: string | null;
            session_url?: string | null;
          }>(`/api/v1/workspaces/${workspaceId}/mobile-sessions`);
          if (!status.data.active || !status.data.session_id) {
            sessionSpinner.fail(
              'No active session — start one with `traceback tunnel up` (or drop --reuse)',
            );
            return;
          }
          sessionId = status.data.session_id;
          sessionUrl = status.data.session_url ?? null;
        } else {
          const res = await api.post<{
            session_id: string;
            session_url: string;
            proxy_path: string;
            device_token: string;
          }>(`/api/v1/workspaces/${workspaceId}/mobile-sessions`, {
            mobile_app_id: null,
            framework: 'native',
          });
          sessionId = res.data.session_id;
          sessionUrl = res.data.session_url;
          proxyPath = res.data.proxy_path;
          deviceToken = res.data.device_token;
        }
        sessionSpinner.succeed(options.reuse ? `Reusing session ${sessionId}` : `Session ${sessionId} created`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios/network error shape not modeled
      } catch (err: any) {
        sessionSpinner.fail(`Failed: ${errorMessage(err)}`);
        return;
      }

      // ── 2. Attach this machine as the agent ────────────────────────────
      const authToken = await getAuthToken(ctx);
      if (!authToken) {
        ui.error('No auth token found — run `traceback login` first.');
        await teardownSession(api, ui, workspaceId, sessionId);
        return;
      }

      const config = await ctx.infra.config.loadGlobalConfig();
      const attachSpinner = ui.spinner('Attaching your device to the cloud engine...');

      // Allow the Appium port (and any custom --appium-url port) through the reverse-port proxy.
      const appiumPort = portOf(appiumUrl) ?? DEFAULT_APPIUM_PORT;
      const allowedTargetPorts = new Set([DEFAULT_APPIUM_PORT, appiumPort]);

      let client: RelayAgentClient | null = null;
      let verifyStarted = false;
      let scrcpyAgent: ScrcpyAgent | null = null;

      const stopTunnel = async (): Promise<void> => {
        try {
          scrcpyAgent?.stop();
        } catch {
          /* already stopped */
        }
        try {
          await client?.stop();
        } catch {
          /* already closed */
        }
      };
      const teardown = async (): Promise<void> => {
        await stopTunnel();
        try {
          await api.delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`);
        } catch {
          /* the session will idle-timeout on its own */
        }
      };

      // A Ctrl+C while the engine is driving the device must not strand the session:
      // tear the tunnel down and exit (the --keep path installs its own handler later).
      let interrupted = false;
      const onInterrupt = (): void => {
        if (interrupted) return;
        interrupted = true;
        ui.warn('\nInterrupted — releasing the session...');
        void teardown().finally(() => process.exit(130));
      };
      process.once('SIGINT', onInterrupt);

      // The verdict is produced from inside the client's onReady (fires on hello_ack),
      // so the tunnel is guaranteed up before the engine starts driving the device.
      let resolveVerdict: (v: VerifyVerdict) => void = () => {};
      let rejectVerdict: (err: unknown) => void = () => {};
      const verdictPromise = new Promise<VerifyVerdict>((resolve, reject) => {
        resolveVerdict = resolve;
        rejectVerdict = reject;
      });

      client = new RelayAgentClient({
        apiUrl: config.apiUrl,
        authToken,
        sessionId,
        localUrl,
        allowedTargetPorts,
        logger: {
          debug: (message) => ui.debug(message),
          warn: (message) => ui.debug(message),
        },
        onReady: (info: RelayReadyInfo) => {
          void (async () => {
            if (verifyStarted) return;
            verifyStarted = true;
            try {
              attachSpinner.succeed(`Device attached — session ${info.code ?? info.sessionId}`);

              // ── 3. Register the local Appium server as this session's device ──
              const reportSpinner = ui.spinner('Registering local device...');
              try {
                await api.patch(
                  `/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}/device`,
                  { appium_url: appiumUrl, udid: udid ?? null, device_name: device.name },
                );
                reportSpinner.succeed(`Appium reachable at ${appiumUrl}`);
              } catch (err) {
                reportSpinner.fail(`Failed to register device: ${errorMessage(err)}`);
                throw err;
              }

              // Live device mirroring (scrcpy) — Android only. The device was resolved up
              // front, so scrcpy always has a concrete serial to target (`adb -s <udid>`).
              // Best-effort: mirroring is a nicety, never required — the agent is
              // self-healing and must never fail the verify itself.
              if (platform === 'android') {
                scrcpyAgent = startScrcpyAgent({
                  apiUrl: config.apiUrl,
                  token: authToken,
                  sessionId,
                  udid,
                  onLog: (line) => ui.debug(`[scrcpy] ${line}`),
                });
              }

              // ── 4. Cloud engine drives the device through the tunnel ──
              const verifySpinner = ui.spinner(
                'Cloud engine is driving your device — this can take a few minutes...',
              );
              try {
                const res = await api.post<VerifyVerdict>(
                  `/api/v1/workspaces/${workspaceId}/mcp/verify-mobile`,
                  { goal: options.goal, platform, session_id: sessionId, trigger_type: 'CLI' },
                  // Never auto-retry this call: a retry would re-POST and start a
                  // SECOND run against the same device while the first is still going.
                  { timeout: VERIFY_TIMEOUT_MS, retryAttempts: 0 },
                );
                verifySpinner.succeed('Verification complete');
                resolveVerdict(res.data);
              } catch (err) {
                verifySpinner.fail('Verification failed');
                throw err;
              }
            } catch (err) {
              rejectVerdict(err);
            }
          })();
        },
        onClosed: (reason) => {
          ui.warn(`Tunnel closed: ${reason}`);
        },
      });

      let verdict: VerifyVerdict;
      try {
        await client.connect();
        verdict = await verdictPromise;
      } catch (err) {
        if (ui.isJsonMode()) {
          // Machine-readable failure: still emit a JSON object on stdout (so the MCP
          // server / parent process gets a real error, not empty output) and exit 1.
          ui.renderJson({ status: 'error', passed: false, message: errorMessage(err) });
          process.exitCode = 1;
        } else {
          ui.error(errorMessage(err));
        }
        // --keep only applies after a successful verdict — an error path always
        // releases the session, or the failed tunnel/run would leak until idle-timeout.
        await teardown();
        return;
      }

      // The dangerous phase is over; let the --keep path own SIGINT from here.
      process.removeListener('SIGINT', onInterrupt);

      // ── 5. Render the verdict ──────────────────────────────────────────
      if (ui.isJsonMode()) {
        // Machine-readable mode: print ONLY the verdict JSON to stdout (spinners and
        // human output go to stderr / are suppressed), so `traceback mobile verify --json`
        // can be driven by the MCP server / other tooling and parsed directly.
        ui.renderJson(verdict);
      } else {
        renderVerdict(ui, verdict);
      }

      // --keep is interactive-only: in json mode the verdict JSON is the whole point,
      // and waiting for Ctrl+C would hang a parent process (MCP server).
      if (options.keep && verdict.passed && !ui.isJsonMode()) {
        // Keep the tunnel live for the edit -> hot-reload -> verify loop.
        ui.info('');
        ui.box(
          [
            `Session:   ${sessionId}`,
            `Local Appium: ${appiumUrl}`,
            `Public:    ${sessionUrl ?? 'n/a'}`,
            `Proxy:     ${proxyPath ?? 'n/a'}`,
            `Device token: ${deviceToken ?? 'n/a'}`,
          ].join('\n'),
          { title: 'Tunnel kept alive' },
        );
        ui.info('Save a file in your app — changes flow to the device in ~2s.');
        ui.info('Re-verify with:');
        ui.info(`  traceback mobile verify -g "<goal>" -p ${platform} --reuse --keep`);
        ui.info('\nPress Ctrl+C to stop.\n');
        await waitForInterrupt();
      }

      const stopSpinner = ui.spinner('Releasing the session...');
      await teardown();
      stopSpinner.succeed('Session released');
    });
}

// ── Rendering ──────────────────────────────────────────────────────────────

function renderVerdict(
  ui: CliContext['infra']['ui'],
  verdict: VerifyVerdict,
): void {
  const ok = verdict.passed;
  const duration = formatDuration(verdict.duration_ms);
  ui.info('');
  if (ok) {
    ui.info(`✅ PASSED — ${verdict.steps_passed}/${verdict.steps_total} steps in ${duration}`);
  } else {
    ui.info(`❌ FAILED — ${verdict.steps_passed}/${verdict.steps_total} steps in ${duration}`);
  }
  const steps = verdict.steps ?? [];
  if (steps.length > 0) {
    ui.table(
      ['Step', 'Result', 'Description'],
      steps.map((s, i) => [
        String(i + 1),
        s.status === 'passed' ? '✅' : '❌',
        s.description ?? '',
      ]),
    );
  }
  if (verdict.summary) {
    ui.info(`\nSummary: ${verdict.summary}`);
  }
  if (verdict.message) {
    ui.warn(`\n${verdict.message}`);
  }
  if (verdict.video_url) {
    ui.info(`Video: ${verdict.video_url}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Resolve the workspace id the same way `traceback workspaces` persists it. */
async function resolveWorkspaceId(
  ctx: CliContext,
  explicit: string | undefined,
): Promise<string | null> {
  if (explicit) return explicit;
  const config = await ctx.infra.config.loadGlobalConfig();
  return config.workspaceId ?? null;
}

async function getAuthToken(ctx: CliContext): Promise<string | null> {
  const token = await ctx.infra.authStore.get();
  return token?.accessToken ?? null;
}

async function teardownSession(
  api: CliContext['infra']['api'],
  ui: CliContext['infra']['ui'],
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  try {
    await api.delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`);
  } catch {
    ui.warn('Could not confirm teardown — the session will idle-timeout on its own.');
  }
}

function portOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : null;
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function waitForInterrupt(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (): void => {
      process.removeListener('SIGINT', handler);
      resolve();
    };
    process.on('SIGINT', handler);
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
