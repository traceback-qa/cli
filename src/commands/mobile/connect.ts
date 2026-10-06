/**
 * `traceback mobile connect` / `traceback connect`
 *
 * Cloud-to-Local Mobile Test Execution Bridge Daemon.
 *
 * Keeps the CLI connected to Traceback Cloud over Socket.IO. Automatically discovers
 * local Android emulators, iOS simulators, and USB devices, registers them with the
 * workspace, and executes mobile tests triggered from the Traceback Web App.
 */

import type { Command } from 'commander';
import type { CliContext } from '../../types/context.js';
import { createRequireAuthMiddleware } from '../../middleware/require-auth.js';
import { io, type Socket } from 'socket.io-client';
import os from 'node:os';
import chalk from 'chalk';
import boxen from 'boxen';
import { detectDevices, type MobileDevice } from '../../infrastructure/mobile/device.detector.js';
import {
  ensureAppiumServer,
  DEFAULT_APPIUM_URL,
  type AppiumServerHandle,
} from '../../infrastructure/mobile/appium.server.js';
import type { AppiumSession } from '../../infrastructure/mobile/appium.bridge.js';

type ContextGetter = (cmd: Command) => CliContext | undefined;

interface BridgeState {
  socket: Socket | null;
  sessionId: string | null;
  serverHandle: AppiumServerHandle | null;
  activeAppiumSession: AppiumSession | null;
  devices: MobileDevice[];
  currentRun: {
    runId: string;
    testName?: string;
    deviceName?: string;
    platform: string;
    startedAt: number;
    stepCount: number;
  } | null;
  watcherTimer: NodeJS.Timeout | null;
  isShuttingDown: boolean;
}

/** Format list of connected devices for terminal display */
function renderDeviceList(devices: MobileDevice[]): string {
  if (!devices.length) {
    return chalk.dim('  (No running simulators or emulators detected)');
  }
  return devices
    .map((d) => {
      const icon = d.platform === 'ios' ? '🍎' : '🤖';
      const kind = d.platform === 'ios' ? 'iOS Simulator' : 'Android Device/Emulator';
      return `  ${icon}  ${chalk.bold(d.name)} ${chalk.dim(`(${d.platform}, ${d.id.slice(0, 12)}…)`)} — ${chalk.gray(kind)} [${d.state}]`;
    })
    .join('\n');
}

/** Render the Standby status box in the terminal */
function renderStandbyBox(
  ui: CliContext['infra']['ui'],
  workspaceId: string,
  host: string,
  devices: MobileDevice[],
  sessionId: string,
): void {
  const content =
    `${chalk.hex('#6366F1').bold('⚡ Traceback Mobile Bridge Connected')}\n\n` +
    `  ${chalk.dim('Host Machine:')}    ${chalk.white(host)}\n` +
    `  ${chalk.dim('Workspace ID:')}    ${chalk.white(workspaceId)}\n` +
    `  ${chalk.dim('Bridge Session:')}  ${chalk.cyan(sessionId.slice(0, 16))}…\n` +
    `  ${chalk.dim('Status:')}          ${chalk.green('● Ready & Listening for test runs from Web Dashboard')}\n\n` +
    `${chalk.bold('Detected Local Devices:')}\n` +
    `${renderDeviceList(devices)}\n\n` +
    `${chalk.dim('Tip: Go to the Traceback Web App, click "Run locally" on any mobile test, and select this runner.')}\n` +
    `${chalk.dim('Press Ctrl+C to disconnect.')}`;

  /* eslint-disable no-console */
  console.clear();
  console.log(
    boxen(content, {
      padding: 1,
      margin: 0,
      borderColor: '#6366F1',
      borderStyle: 'round',
    }),
  );
  /* eslint-enable no-console */
}

/** Check if two device lists have differences in IDs or count */
function haveDevicesChanged(a: MobileDevice[], b: MobileDevice[]): boolean {
  if (a.length !== b.length) return true;
  const setA = new Set(a.map((d) => d.id));
  return b.some((d) => !setA.has(d.id));
}

export async function runMobileConnect(
  ctx: CliContext,
  opts: {
    workspace?: string;
    appiumUrl?: string;
  },
): Promise<void> {
  const ui = ctx.infra.ui;
  const config = await ctx.infra.config.loadGlobalConfig();
  const token = await ctx.infra.auth.getToken();

  if (!token) {
    ui.error('Not authenticated. Run `traceback login` first.');
    return;
  }

  const workspaceId = opts.workspace || config.workspaceId;
  if (!workspaceId) {
    ui.error('No workspace selected. Use --workspace <id> or run `traceback workspaces select`.');
    return;
  }

  const appiumUrl = opts.appiumUrl || DEFAULT_APPIUM_URL;
  const host = os.hostname();

  const state: BridgeState = {
    socket: null,
    sessionId: null,
    serverHandle: null,
    activeAppiumSession: null,
    devices: [],
    currentRun: null,
    watcherTimer: null,
    isShuttingDown: false,
  };

  const startupSpinner = ui.spinner('Initializing Traceback mobile bridge...');

  // 1. Ensure local Appium server is running
  try {
    startupSpinner.setText('Checking local Appium server...');
    state.serverHandle = await ensureAppiumServer({
      appiumUrl,
      onStatus: (msg) => startupSpinner.setText(msg),
    });
  } catch (err: unknown) {
    startupSpinner.fail(
      `Failed to start Appium server: ${err instanceof Error ? err.message : String(err)}`,
    );
    ui.hint('Make sure Appium is installed: `traceback setup`');
    return;
  }

  // 2. Discover initial local devices
  startupSpinner.setText('Scanning for connected mobile devices and emulators...');
  const { devices } = detectDevices();
  state.devices = devices;

  // 3. Connect Socket.IO to Traceback Cloud
  startupSpinner.setText('Connecting bridge to Traceback Cloud...');

  const socketUrl = config.apiUrl.replace(/\/+$/, '');
  const socket = io(socketUrl, {
    auth: { token: token.accessToken },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    timeout: 30_000,
  });
  state.socket = socket;

  const cleanup = async (): Promise<void> => {
    if (state.isShuttingDown) return;
    state.isShuttingDown = true;

    if (state.watcherTimer) {
      clearInterval(state.watcherTimer);
      state.watcherTimer = null;
    }

    if (state.activeAppiumSession) {
      try {
        await state.activeAppiumSession.close();
      } catch {}
      state.activeAppiumSession = null;
    }

    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }

    if (state.serverHandle?.startedByUs) {
      try {
        await state.serverHandle.stop();
      } catch {}
    }

    ui.info('\nMobile bridge disconnected cleanly.');
  };

  const onSigint = async () => {
    await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);

  socket.on('connect', () => {
    socket.emit('cli_auth', {
      token: token.accessToken,
      type: 'mobile_daemon',
      workspaceId,
      host,
      platform: process.platform,
      sessionId: state.sessionId || undefined,
      devices: state.devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        state: d.state,
      })),
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io payload shape
  socket.on('cli_authenticated', (data: any) => {
    state.sessionId = data.session_id;
    startupSpinner.stop();
    renderStandbyBox(ui, workspaceId, host, state.devices, state.sessionId!);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io payload shape
  socket.on('cli_error', (data: any) => {
    startupSpinner.fail(data.message || 'CLI authentication failed');
    void cleanup();
  });

  socket.on('connect_error', (err: Error) => {
    if (!state.sessionId) {
      startupSpinner.fail(`Connection error: ${err.message}`);
    }
  });

  // 4. Handle incoming dispatched test run from Web App
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io payload shape
  socket.on('dispatch_run', (payload: any) => {
    const { run_id, test_id, test_name, device_id, platform, device_name } = payload || {};
    if (!run_id) return;

    state.currentRun = {
      runId: run_id,
      testName: test_name || test_id || 'Mobile Test',
      deviceName: device_name || device_id,
      platform: platform || 'android',
      startedAt: Date.now(),
      stepCount: 0,
    };

    /* eslint-disable no-console */
    console.clear();
    console.log(
      boxen(
        `${chalk.hex('#6366F1').bold('🚀 Executing Test Run from Cloud')}\n\n` +
          `  ${chalk.dim('Test:')}        ${chalk.bold.white(state.currentRun.testName)}\n` +
          `  ${chalk.dim('Run ID:')}      ${chalk.cyan(run_id)}\n` +
          `  ${chalk.dim('Target:')}      ${chalk.yellow(state.currentRun.deviceName || device_id)}\n` +
          `  ${chalk.dim('Platform:')}    ${chalk.white(platform)}\n\n` +
          `  ${chalk.green('⚡ Test in progress — actions streaming live…')}`,
        {
          padding: 1,
          borderColor: '#6366F1',
          borderStyle: 'round',
        },
      ),
    );
    /* eslint-enable no-console */
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io payload shape
  socket.on('run_completed', (payload: any) => {
    const status = payload?.status || 'completed';
    const isSuccess = status.toLowerCase() === 'passed' || status.toLowerCase() === 'completed';

    if (state.currentRun) {
      const durationSec = Math.round((Date.now() - state.currentRun.startedAt) / 1000);
      /* eslint-disable no-console */
      console.log(
        boxen(
          `${isSuccess ? chalk.green.bold('✓ Test Completed Successfully') : chalk.red.bold('✗ Test Run Finished')}\n\n` +
            `  ${chalk.dim('Test:')}      ${chalk.white(state.currentRun.testName)}\n` +
            `  ${chalk.dim('Status:')}    ${isSuccess ? chalk.green(status.toUpperCase()) : chalk.red(status.toUpperCase())}\n` +
            `  ${chalk.dim('Duration:')}  ${chalk.white(`${durationSec}s`)}\n`,
          {
            padding: 1,
            borderColor: isSuccess ? 'green' : 'red',
            borderStyle: 'round',
          },
        ),
      );
      /* eslint-enable no-console */
      state.currentRun = null;
    }

    // Wait 3 seconds to show summary then return to Standby UI
    setTimeout(() => {
      if (!state.currentRun && !state.isShuttingDown && state.sessionId) {
        renderStandbyBox(ui, workspaceId, host, state.devices, state.sessionId);
      }
    }, 3500);
  });

  // 5. Start Real-time Device Watcher (every 3 seconds)
  state.watcherTimer = setInterval(() => {
    if (state.isShuttingDown) return;
    const { devices: latestDevices } = detectDevices();
    if (haveDevicesChanged(state.devices, latestDevices)) {
      state.devices = latestDevices;
      if (socket.connected) {
        socket.emit('devices_updated', {
          devices: latestDevices.map((d) => ({
            id: d.id,
            name: d.name,
            platform: d.platform,
            state: d.state,
          })),
        });
      }
      if (!state.currentRun && state.sessionId) {
        renderStandbyBox(ui, workspaceId, host, state.devices, state.sessionId);
      }
    }
  }, 3000);

  // Keep daemon alive
  await new Promise<void>(() => {});
}

export function registerMobileConnectCommand(mobile: Command, getContext: ContextGetter): void {
  mobile
    .command('connect')
    .description(
      'Connect this machine as a local mobile test execution bridge.\n' +
        'Discovers running emulators/simulators and executes tests triggered from the Traceback Web App.',
    )
    .option('--workspace <id>', 'Workspace ID to connect to')
    .option('--appium-url <url>', 'Local Appium server URL', DEFAULT_APPIUM_URL)
    .action(async function (this: Command, options) {
      const ctx = getContext(this);
      if (!ctx) return;

      const requireAuth = createRequireAuthMiddleware(ctx);
      await requireAuth();

      await runMobileConnect(ctx, {
        workspace: options.workspace,
        appiumUrl: options.appiumUrl,
      });
    });
}
