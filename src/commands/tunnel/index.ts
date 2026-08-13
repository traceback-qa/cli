/**
 * `traceback tunnel` — the custom relay tunnel: expose a local dev server to cloud
 * devices through the backend, with no ngrok and no `expo start --tunnel`.
 *
 * The flow:
 *
 *   1. `tunnel up` creates a relay session via
 *      `POST /api/v1/workspaces/{ws}/mobile-sessions` and prints its public URL
 *      (`https://<code>.relay.dev` or the path-based `/relay/s/<code>` fallback).
 *   2. It then attaches this machine as the agent on
 *      `ws://<api>/relay/agent/connect?token=...&session_id=...`. Every HTTP request
 *      a device makes against the public URL is forwarded to the local server, and
 *      device WebSockets (Metro HMR, devtools) are bridged to a local WS endpoint.
 *   3. Ctrl+C tears the session down via `DELETE .../mobile-sessions/{id}`.
 *
 * `share <port>` is a convenience alias of `up` for exposing an arbitrary local port
 * (no mobile build attached). `status` and `down` manage the workspace's active
 * session from another terminal.
 */

import type { Command } from 'commander';
import type { CliContext } from '../../types/context.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';
import {
  RelayAgentClient,
  type RelayReadyInfo,
  type RelayRebuildResult,
} from '../../infrastructure/tunnel/relay/index.js';
import type { ApiClient } from '../../infrastructure/api/api.types.js';
import { detectDevices } from '../../infrastructure/mobile/device.detector.js';
import { startScrcpyAgent, type ScrcpyAgent } from '../../infrastructure/mobile/scrcpy-agent.js';
import { runNativeRebuild, type NativeRebuildOptions } from './native-rebuild.js';

type ContextGetter = (cmd: Command) => CliContext | undefined;

const DEFAULT_PORT = '8081';

interface TunnelUpOptions {
  port?: string;
  localUrl?: string;
  localWsUrl?: string;
  app?: string;
  framework?: string;
  udid?: string;
  workspace?: string;
}

interface TunnelManageOptions {
  session?: string;
  workspace?: string;
}

interface TunnelRebuildOptions {
  framework?: string;
  project?: string;
  scheme?: string;
  bundleId?: string;
  udid?: string;
  projectDir?: string;
  package?: string;
  activity?: string;
  message?: string;
  dryRun?: boolean;
  workspace?: string;
  session?: string;
}

export function registerTunnelCommands(program: Command, getContext: ContextGetter): void {
  const tunnel = program
    .command('tunnel')
    .description('Live relay tunnel — expose a local dev server to cloud devices');

  tunnel
    .command('up')
    .description(
      'Create a relay session and attach this machine as the agent. HTTP traffic to the\n' +
        "session's public URL is forwarded to your local server (default :8081).\n" +
        'Ctrl+C to stop and tear the session down.',
    )
    .option('-p, --port <port>', `Local port to expose (default ${DEFAULT_PORT})`)
    .option('-u, --local-url <url>', 'Full local server URL (overrides --port)')
    .option('--local-ws-url <url>', 'Local WebSocket endpoint for device channels (HMR)')
    .option('-a, --app <build>', 'Mobile build name to note on the session')
    .option('-f, --framework <name>', 'expo | react-native | flutter | native', 'expo')
    .option('--udid <id>', 'Android emulator/device serial for the live screen stream')
    .option('-w, --workspace <id>', 'Workspace ID (defaults to current)')
    .action(async function (this: Command, options: TunnelUpOptions) {
      await runTunnelUp(getContext(this), options);
    });

  tunnel
    .command('share <port>')
    .description('Share any local HTTP port through the tunnel (no mobile app)')
    .option('--local-ws-url <url>', 'Local WebSocket endpoint for device channels')
    .option('-f, --framework <name>', 'expo | react-native | flutter | native', 'native')
    .option('-w, --workspace <id>', 'Workspace ID (defaults to current)')
    .action(async function (this: Command, port: string, options: TunnelUpOptions) {
      await runTunnelUp(getContext(this), { ...options, port });
    });

  tunnel
    .command('rebuild')
    .description(
      'Rebuild, reinstall, and relaunch a native (iOS/Kotlin) app on the attached device —\n' +
        'the "live update" for frameworks with no hot reload. Reports rebuild_done through\n' +
        'the tunnel so the backend knows the device now runs a fresh build.',
    )
    .option('-f, --framework <name>', 'ios | kotlin (defaults to ios)')
    .option('--project <path>', 'Xcode project (.xcodeproj or .xcworkspace) — iOS only')
    .option('--scheme <name>', 'Xcode scheme — iOS only')
    .option('--bundle-id <id>', 'Bundle id to launch — iOS only (auto-read from the built app)')
    .option('--udid <id>', 'Device UDID — iOS only (defaults to the booted simulator)')
    .option('--project-dir <dir>', 'Android project root (where gradlew lives) — kotlin only')
    .option('--package <applicationId>', 'Android applicationId — kotlin only')
    .option('--activity <activity>', 'Android activity to launch (default .MainActivity)')
    .option('--message <text>', 'Reason for the rebuild (shown in the session record)')
    .option('--dry-run', 'Fake the build so the tunnel wiring can be tested without a project')
    .option('-w, --workspace <id>', 'Workspace ID (defaults to current)')
    .option('-s, --session <id>', 'Session ID (defaults to the active session)')
    .action(async function (this: Command, options: TunnelRebuildOptions) {
      const ctx = getContext(this);
      if (!ctx) return;
      await runTunnelRebuild(getContext(this), options);
    });

  tunnel
    .command('status')
    .description("Show the workspace's active relay session")
    .option('-w, --workspace <id>', 'Workspace ID (defaults to current)')
    .action(async function (this: Command, options: TunnelManageOptions) {
      const ctx = getContext(this);
      if (!ctx) return;
      await createRequireAuthMiddleware(ctx)();

      const { api, ui } = ctx.infra;
      const workspaceId = await resolveWorkspaceId(ctx, options.workspace);
      if (!workspaceId) {
        ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
        return;
      }

      const spinner = ui.spinner('Checking for an active session...');
      try {
        const status = await api.get<{
          active: boolean;
          session_id?: string | null;
          session_url?: string | null;
          status?: string | null;
        }>(`/api/v1/workspaces/${workspaceId}/mobile-sessions`);
        spinner.succeed('Done');
        if (!status.data.active) {
          ui.info('No active relay session. Start one with:');
          ui.info('  traceback tunnel up');
          return;
        }
        ui.table(
          ['Property', 'Value'],
          [
            ['Active', String(status.data.active)],
            ['Session', status.data.session_id ?? '-'],
            ['Status', status.data.status ?? '-'],
            ['Public URL', status.data.session_url ?? '-'],
          ],
        );
      } catch (err) {
        spinner.fail(`Failed to check session status: ${errorMessage(err)}`);
      }
    });

  tunnel
    .command('down')
    .description("Tear down the workspace's active relay session")
    .option('-s, --session <id>', 'Session ID (defaults to the active session)')
    .option('-w, --workspace <id>', 'Workspace ID (defaults to current)')
    .action(async function (this: Command, options: TunnelManageOptions) {
      const ctx = getContext(this);
      if (!ctx) return;
      await createRequireAuthMiddleware(ctx)();

      const { api, ui } = ctx.infra;
      const workspaceId = await resolveWorkspaceId(ctx, options.workspace);
      if (!workspaceId) {
        ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
        return;
      }

      const sessionId = options.session ?? (await findActiveSessionId(api, workspaceId));
      if (!sessionId) {
        ui.warn('No active relay session to tear down.');
        return;
      }

      const spinner = ui.spinner(`Tearing down session ${sessionId}...`);
      try {
        await api.delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`);
        spinner.succeed('Session torn down');
      } catch (err) {
        spinner.fail(`Failed to tear down session: ${errorMessage(err)}`);
      }
    });
}

async function runTunnelUp(ctx: CliContext | undefined, options: TunnelUpOptions): Promise<void> {
  if (!ctx) return;
  await createRequireAuthMiddleware(ctx)();

  const { api, ui } = ctx.infra;
  const workspaceId = await resolveWorkspaceId(ctx, options.workspace);
  if (!workspaceId) {
    ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
    return;
  }

  const port = options.port ?? DEFAULT_PORT;
  const localUrl = options.localUrl ?? `http://localhost:${port}`;
  const framework = options.framework ?? 'expo';
  const localWsUrl = options.localWsUrl ?? defaultLocalWsUrl(localUrl, framework);

  // ── 1. Create the session ───────────────────────────────────────────
  const createSpinner = ui.spinner('Creating relay session...');
  let sessionId: string;
  let sessionUrl: string;
  let proxyPath: string;
  let deviceToken: string;
  try {
    const res = await api.post<{
      session_id: string;
      session_url: string;
      proxy_path: string;
      device_token: string;
      status: string;
    }>(`/api/v1/workspaces/${workspaceId}/mobile-sessions`, {
      mobile_app_id: options.app ?? null,
      framework,
    });
    sessionId = res.data.session_id;
    sessionUrl = res.data.session_url;
    proxyPath = res.data.proxy_path;
    deviceToken = res.data.device_token;
    createSpinner.succeed('Session created');
  } catch (err) {
    createSpinner.fail(`Failed to create session: ${errorMessage(err)}`);
    return;
  }

  // ── 2. Attach this machine as the agent ─────────────────────────────
  const authToken = await getAuthToken(ctx);
  if (!authToken) {
    ui.error('No auth token found — run `traceback login` first.');
    await api.delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`);
    return;
  }

  const config = await ctx.infra.config.loadGlobalConfig();
  const attachSpinner = ui.spinner('Attaching local server to the relay...');

  let client: RelayAgentClient | null = null;
  const streamRef: { current: ScrcpyAgent | null } = { current: null };
  const stopStreamAgent = (): void => {
    const agent = streamRef.current;
    streamRef.current = null;
    agent?.stop();
  };
  client = new RelayAgentClient({
    apiUrl: config.apiUrl,
    authToken,
    sessionId,
    localUrl,
    localWsUrl,
    logger: {
      debug: (message) => ui.debug(message),
      warn: (message) => ui.debug(message),
    },
    onReady: (info: RelayReadyInfo) => {
      attachSpinner.succeed('Tunnel live');

      // Persist the selected emulator on the workspace session as well as streaming it.
      // The Device Fleet UI uses this durable reference to label the session and expose
      // its live-view action. This endpoint records metadata only; Appium remains optional
      // for the screen-stream walkthrough.
      const streamUdid = options.udid ?? soleAndroidUdid();
      void api
        .patch(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}/device`, {
          appium_url: 'http://localhost:4723',
          udid: streamUdid,
        })
        .catch((err) => ui.debug(`Could not register device metadata: ${errorMessage(err)}`));

      // The viewer page is separate from the HTTP tunnel: it needs a stream agent
      // pushing the attached Android screen into `/relay/agent/stream`. Start it
      // after the relay handshake so the session is known to be live, and keep it
      // best-effort so a tunnel still works when no Android device is attached.
      if (streamUdid && streamRef.current === null) {
        streamRef.current = startScrcpyAgent({
          apiUrl: config.apiUrl,
          token: authToken,
          sessionId,
          udid: streamUdid,
          onLog: (line) => ui.debug(`[scrcpy] ${line}`),
        });
        ui.info(`Starting live screen stream for ${streamUdid}...`);
      } else {
        ui.debug(
          'Live screen stream not started: no Android emulator/device found. ' +
            'Pass --udid <serial> to select one.',
        );
      }
      ui.box(
        [
          `Session:   ${info.sessionId}`,
          `Local:     ${localUrl}`,
          `Public:    ${sessionUrl}`,
          `Proxy:     ${proxyPath}`,
          `Framework: ${info.framework ?? framework}`,
          `Device token: ${deviceToken}`,
        ].join('\n'),
        { title: 'Relay tunnel' },
      );
      ui.info('Try it from another terminal:');
      ui.info(`  curl ${proxyPath}/ -H "X-Device-Token: ${deviceToken}"`);
      ui.info('');
      ui.info('Save a file in your app — changes flow to devices in ~2s.');
      ui.info('\nPress Ctrl+C to stop.\n');
    },
    onClosed: (reason) => {
      stopStreamAgent();
      ui.warn(`Relay closed: ${reason}`);
    },
  });

  try {
    await client.connect();
  } catch (err) {
    attachSpinner.fail(`Failed to attach: ${errorMessage(err)}`);
    await api.delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`);
    return;
  }

  await waitForInterrupt();

  const stopSpinner = ui.spinner('Tearing down the session...');
  stopStreamAgent();
  await client.stop();
  try {
    await api.delete(`/api/v1/workspaces/${workspaceId}/mobile-sessions/${sessionId}`);
    stopSpinner.succeed('Session released');
  } catch {
    stopSpinner.warn('Could not confirm teardown — the session will idle-timeout on its own.');
  }
}

async function runTunnelRebuild(ctx: CliContext | undefined, options: TunnelRebuildOptions): Promise<void> {
  if (!ctx) return;
  await createRequireAuthMiddleware(ctx)();

  const { api, ui } = ctx.infra;
  const workspaceId = await resolveWorkspaceId(ctx, options.workspace);
  if (!workspaceId) {
    ui.error('No workspace selected. Use --workspace <id> or:\n  traceback workspaces select');
    return;
  }

  const framework = options.framework === 'kotlin' ? 'kotlin' : 'ios';
  const sessionId = options.session ?? (await findActiveSessionId(api, workspaceId));
  if (!sessionId) {
    ui.error(
      'No active relay session. Start one first:\n' +
        '  traceback tunnel up -f native\n' +
        'or pass --session <id>.',
    );
    return;
  }

  const authToken = await getAuthToken(ctx);
  if (!authToken) {
    ui.error('No auth token found — run `traceback login` first.');
    return;
  }
  const config = await ctx.infra.config.loadGlobalConfig();

  const rebuildOptions: NativeRebuildOptions = {
    framework,
    project: options.project,
    scheme: options.scheme,
    bundleId: options.bundleId,
    udid: options.udid,
    projectDir: options.projectDir,
    packageName: options.package,
    activity: options.activity,
    dryRun: options.dryRun,
    onLine: (line) => ui.debug(line),
  };

  let client: RelayAgentClient | null = null;
  try {
    // Attach so we can signal the backend. If `tunnel up` is running in another
    // terminal, this connection temporarily replaces it (resume semantics) for the
    // rebuild — so reconnect MUST be disabled: with it on, the displaced `tunnel up`
    // client would auto-reconnect and kick THIS agent back, and the two would flap
    // forever kicking each other. One-shot attach → rebuild → signal → exit.
    client = new RelayAgentClient({
      apiUrl: config.apiUrl,
      authToken,
      sessionId,
      localUrl: 'http://localhost:8081',
      reconnect: false,
      logger: {
        debug: (message) => ui.debug(message),
        warn: (message) => ui.debug(message),
      },
      onReady: () => {
        void (async () => {
          const spinner = ui.spinner(
            `Rebuilding ${framework} app (${options.dryRun ? 'dry-run' : 'this can take a few minutes'})...`,
          );
          const result = await runNativeRebuild(rebuildOptions);
          if (result.status === 'built') {
            spinner.succeed(result.message);
          } else {
            spinner.fail(result.message);
          }
          client?.sendRebuildDone(result);
          ui.info(
            result.status === 'built'
              ? '✅ rebuild_done reported to the backend — the device now runs a fresh build.'
              : '❌ rebuild failed — reported to the backend so the engine can react.',
          );
          ui.info('\nPress Ctrl+C to stop the tunnel.\n');
        })();
      },
      // Also serve cloud-initiated rebuild requests while this agent is attached.
      onRebuildRequest: async (request) => {
        ui.warn(`Backend requested a rebuild: ${request.message || 'no reason given'}`);
        const result = await runNativeRebuild({ ...rebuildOptions, framework: request.framework });
        if (result.status === 'built') {
          ui.info(result.message);
        } else {
          ui.error(result.message);
        }
        return result as RelayRebuildResult;
      },
    });
    await client.connect();
  } catch (err) {
    ui.error(`Failed to attach for rebuild: ${errorMessage(err)}`);
    await client?.stop().catch(() => {});
    return;
  }

  await waitForInterrupt();

  const stopSpinner = ui.spinner('Releasing the session...');
  await client.stop();
  stopSpinner.succeed('Session released');
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Resolve the workspace id the same way `traceback mobile dev` does — from config. */
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

async function findActiveSessionId(api: ApiClient, workspaceId: string): Promise<string | null> {
  try {
    const status = await api.get<{ active: boolean; session_id?: string | null }>(
      `/api/v1/workspaces/${workspaceId}/mobile-sessions`,
    );
    return status.data.active ? (status.data.session_id ?? null) : null;
  } catch {
    return null;
  }
}

function soleAndroidUdid(): string | null {
  const androidDevices = detectDevices().filter((device) => device.platform === 'android');
  return androidDevices.length === 1 ? (androidDevices[0]?.id ?? null) : null;
}

function defaultLocalWsUrl(localUrl: string, framework: string): string {
  const base = localUrl.replace(/^http/, 'ws');
  return framework === 'expo' || framework === 'react-native' ? `${base}/hot` : base;
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
