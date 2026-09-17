/**
 * Tests command — browse, select, and run tests from the CLI.
 *
 * Supports two run modes:
 *   - Cloud: runs on the server's headless browser (default)
 *   - Local: launches Chrome on the user's machine, connects via CDP tunnel,
 *            and the backend agent controls the user's browser remotely
 */

import type { Command } from 'commander';
import type { getContext as GetContextFn } from '../../cli.js';
import type { CliContext } from '../../types/context.js';
import chalk from 'chalk';
import type {
  MobileDevice,
  DeviceDetectionDiagnostics,
} from '../../infrastructure/mobile/device.detector.js';

type ContextGetter = typeof GetContextFn;

/** Prints an accurate warning for "no devices" — distinguishing a genuine "nothing's booted"
 * from `adb`/`xcrun` being unresolvable at all (most often a stale terminal's PATH not having
 * picked up a just-installed Android Studio/Xcode), which used to produce the same generic
 * "start an emulator" message even when one was already running. Shared by both mobile flows
 * below (saved-test device picker and live-verify) since they hit the exact same gap. */
function warnNoDevices(ctx: CliContext, diagnostics: DeviceDetectionDiagnostics): void {
  const { androidToolFound, iosToolFound, iosNeedsXcodeSelect } = diagnostics;

  if (!androidToolFound && !iosToolFound) {
    ctx.infra.ui.warn("Couldn't find `adb` or `xcrun` — can't check for running devices.");
    ctx.infra.ui.hint('If you just installed Android Studio or Xcode, open a new terminal');
    ctx.infra.ui.hint("(PATH changes don't apply to a terminal that was already open).");
    if (iosNeedsXcodeSelect) {
      ctx.infra.ui.hint(
        'Also run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      );
    }
    return;
  }

  if (!androidToolFound) {
    ctx.infra.ui.warn("Couldn't find `adb` on your PATH.");
    ctx.infra.ui.hint('If you just installed Android Studio, open a new terminal (PATH changes');
    ctx.infra.ui.hint("don't apply to a terminal that was already open) — or add");
    ctx.infra.ui.hint('$ANDROID_HOME/platform-tools to your PATH yourself.');
    return;
  }

  if (!iosToolFound) {
    if (iosNeedsXcodeSelect) {
      ctx.infra.ui.warn(
        'Xcode is installed, but `xcode-select` still points at the bare Command Line Tools,',
      );
      ctx.infra.ui.warn("which can't see the Simulator.");
      ctx.infra.ui.hint(
        'Fix it with: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      );
    } else {
      ctx.infra.ui.warn("Couldn't run `xcrun` — is Xcode or the Command Line Tools installed?");
      ctx.infra.ui.hint('Install them with `xcode-select --install`, or open Xcode.');
    }
    return;
  }

  // Both tools resolved fine — genuinely nothing booted.
  ctx.infra.ui.warn('No running emulators or simulators found.');
  ctx.infra.ui.hint('Start an Android emulator or iOS simulator and try again.');
  ctx.infra.ui.hint('  Android: `emulator -avd <name>` or open Android Studio');
  ctx.infra.ui.hint('  iOS:     `open -a Simulator` or open Xcode');
}

interface Test {
  id: string;
  name: string;
  goal?: string;
  platform?: string;
  status?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- per-environment config shape not modeled client-side
  environments?: Record<string, any>;
}

export function registerTestCommands(program: Command, getContext: ContextGetter): void {
  program
    .command('tests')
    .description('Browse and run tests')
    .action(async function (this: Command) {
      const ctx = getContext(this);
      if (!ctx) return;

      const isAuth = await ctx.infra.auth.isAuthenticated();
      if (!isAuth) {
        ctx.infra.ui.warn('Not authenticated. Run `traceback login` first.');
        return;
      }

      const config = await ctx.infra.config.loadGlobalConfig();
      const workspaceId = config.workspaceId;
      if (!workspaceId) {
        ctx.infra.ui.warn('No workspace selected. Run `traceback workspaces` first.');
        return;
      }

      // Step 1: Ask what type of tests to browse
      const { select } = await import('@inquirer/prompts');
      const platform = await select({
        message: 'What type of tests?',
        choices: [
          { name: '🌐  Web tests', value: 'web' },
          { name: '📱  Mobile tests', value: 'mobile' },
        ],
      });

      // Step 1.5 (mobile only): live verify against a device
      if (platform === 'mobile') {
        await handleMobileLiveVerify(ctx, workspaceId);
        return;
      }

      // Step 2: Fetch tests from the backend
      const spinner = ctx.infra.ui.spinner('Fetching tests...');
      let tests: Test[];
      try {
        const result = await ctx.infra.api.get<Test[]>(`/api/v1/workspaces/${workspaceId}/tests`);
        tests = (result.data || []).filter((t) => {
          if ((t.platform || 'web') !== platform) return false;
          return true;
        });
        spinner.stop();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
      } catch (error: any) {
        if (error.response?.status === 404) {
          spinner.fail('Workspace not found (404)');
          ctx.infra.ui.warn('The configured workspace might have been deleted.');
          ctx.infra.ui.hint('Run `traceback workspaces` to select a valid workspace.');
          return;
        }
        if (error.response?.status === 403) {
          spinner.fail('Access denied (403)');
          ctx.infra.ui.warn('You do not have access to the currently configured workspace.');
          ctx.infra.ui.hint('Run `traceback workspaces` to select a workspace for your account.');
          return;
        }
        spinner.fail('Failed to fetch tests');
        throw error;
      }

      if (!tests.length) {
        ctx.infra.ui.warn(`No ${platform} tests found in this workspace.`);
        return;
      }

      // Step 3: Let the user search and pick a test
      const { search } = await import('@inquirer/prompts');
      const testId = await search({
        message: `Search or select a ${platform} test`,
        source: async (input) => {
          const term = (input || '').trim().toLowerCase();
          const filtered = term
            ? tests.filter(
                (t) =>
                  t.name.toLowerCase().includes(term) ||
                  (t.goal && t.goal.toLowerCase().includes(term)),
              )
            : tests;

          return filtered.map((t) => {
            const statusBadge = t.status ? chalk.dim(` [${t.status}]`) : '';
            const goalPreview = t.goal ? chalk.gray(`  —  ${t.goal.slice(0, 50)}`) : '';
            return {
              name: `${chalk.bold(t.name)}${statusBadge}${goalPreview}`,
              value: t.id,
            };
          });
        },
      });

      const selected = tests.find((t) => t.id === testId);
      if (!selected) return;

      // Step 4: Run the selected test locally (opens Chrome on the user's machine)
      const envs = Object.keys(selected.environments || {});
      let environment = envs[0] || 'production';
      if (envs.length > 1) {
        environment = await select({
          message: 'Select an environment',
          choices: envs.map((e) => ({ name: e, value: e })),
          default: envs.includes('production') ? 'production' : envs[0],
        });
      } else if (envs.length === 1) {
        ctx.infra.ui.hint(`Environment: ${environment}`);
      }

      await runLocally(ctx, workspaceId, testId, selected.name, environment);
    });
}

/**
 * Run a test in the cloud (server-side headless browser).
 */
async function runInCloud(
  ctx: CliContext,
  workspaceId: string,
  testId: string,
  testName: string,
  environment: string,
): Promise<void> {
  // Asked before the run is dispatched, not after -- answering this while a run has already
  // silently started server-side (the previous shape: start, print "Run started", then ask) felt
  // like the CLI didn't wait for input at all.
  const { confirm } = await import('@inquirer/prompts');
  const watchLive = await confirm({ message: 'Watch this run live?', default: true });

  const spinner = ctx.infra.ui.spinner(`Starting cloud run for "${testName}"...`);
  let runId: string;
  try {
    const result = await ctx.infra.api.post<{ run_id: string }>(
      `/api/v1/workspaces/${workspaceId}/tests/${testId}/run`,
      { environment, viewport: 'desktop' },
    );
    runId = result.data.run_id;
    spinner.succeed(`Run started: ${runId}`);
  } catch (error) {
    spinner.fail('Failed to start run');
    throw error;
  }

  if (!watchLive) {
    ctx.infra.ui.hint('View results at traceback.dev or use `traceback runs`');
    return;
  }

  const { watchRun } = await import('../../infrastructure/socket/run-events.client.js');
  const token = await ctx.infra.auth.getToken();
  if (!token) {
    ctx.infra.ui.warn('Not authenticated — cannot open a live stream.');
    ctx.infra.ui.hint(`View results at traceback.dev, or run \`traceback runs\` for run ${runId}`);
    return;
  }

  const config = await ctx.infra.config.loadGlobalConfig();
  const controller = new AbortController();
  const onSigint = (): void => {
    ctx.infra.ui.info('\nStopped watching (the run itself keeps going in the cloud).');
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  try {
    ctx.infra.ui.hint('Press Ctrl+C to stop watching (the run keeps going either way).');
    await watchRun(config.apiUrl, token.accessToken, runId, ctx.infra.ui, controller.signal, {
      testName,
      environment,
      targetName: 'Cloud Headless Browser',
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/**
 * Run a test locally by launching Chrome and connecting via CDP tunnel.
 *
 * Flow:
 *   1. Launch Chrome with --remote-debugging-port=9222
 *   2. Get the CDP WebSocket URL from Chrome
 *   3. Connect a WebSocket tunnel to the backend
 *   4. Advertise the CDP URL through the tunnel
 *   5. Dispatch the test run with the tunnel_id
 *   6. The backend worker connects to our Chrome and runs the test
 *   7. User watches it happen live in their Chrome window
 *   8. Clean up: close tunnel and Chrome when done
 */
export async function runLocally(
  ctx: CliContext,
  workspaceId: string,
  testId: string,
  testName: string,
  environment: string,
): Promise<void> {
  const { launchChrome } = await import('../../infrastructure/browser/chrome.launcher.js');
  const { connectTunnel } = await import('../../infrastructure/tunnel/tunnel.client.js');

  const token = await ctx.infra.auth.getToken();
  if (!token) {
    ctx.infra.ui.warn('Not authenticated. Run `traceback login` first.');
    return;
  }
  const config = await ctx.infra.config.loadGlobalConfig();

  // Step 1: Launch default or installed Chromium browser with CDP enabled
  const launchSpinner = ctx.infra.ui.spinner('Launching browser with remote debugging...');
  let chrome;
  try {
    chrome = await launchChrome();
    if (chrome.fallbackFrom) {
      ctx.infra.ui.hint(
        `Default browser (${chrome.fallbackFrom}) does not support CDP; using ${chrome.browserName}.`,
      );
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    launchSpinner.fail(`Failed to launch browser: ${msg}`);
    return;
  }

  // Step 2: Connect tunnel to backend and advertise the CDP URL
  launchSpinner.setText(`Connecting CDP tunnel to Traceback Cloud...`);
  let tunnel;
  try {
    tunnel = await connectTunnel(config.apiUrl, token.accessToken, chrome.cdpUrl);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    launchSpinner.fail(`Tunnel failed: ${msg}`);
    chrome.kill();
    return;
  }

  // Step 3: Dispatch the test run with the tunnel_id
  launchSpinner.setText(`Dispatching test run "${testName}"...`);
  try {
    const result = await ctx.infra.api.post<{ run_id: string }>(
      `/api/v1/workspaces/${workspaceId}/tests/${testId}/run`,
      {
        environment,
        viewport: 'desktop',
        tunnel_id: tunnel.tunnelId,
      },
    );
    const runId = result.data.run_id;
    launchSpinner.succeed(`Connected to Traceback Cloud (Run: ${chalk.cyan(runId)})`);

    ctx.infra.ui.box(
      `${chalk.hex('#6366F1').bold('🧪 ' + testName)}\n\n` +
        `  ${chalk.dim('Run ID:')}      ${chalk.cyan(runId)}\n` +
        `  ${chalk.dim('Environment:')} ${chalk.white(environment)}\n` +
        `  ${chalk.dim('Target:')}      ${chalk.white(chrome.browserName)} ${chalk.dim('(Local CDP Tunnel)')}\n` +
        `  ${chalk.dim('Controls:')}    ${chalk.dim('[q / Ctrl+C] Detach • [v] Toggle Reasoning')}`,
      { title: 'Test Session', borderColor: '#6366F1' },
    );

    const { watchRun } = await import('../../infrastructure/socket/run-events.client.js');
    const controller = new AbortController();
    const onSigint = (): void => {
      ctx.infra.ui.info('\nStopped watching (stopping local Chrome and tunnel).');
      controller.abort();
    };
    process.on('SIGINT', onSigint);

    try {
      await watchRun(config.apiUrl, token.accessToken, runId, ctx.infra.ui, controller.signal, {
        testName,
        environment,
        targetName: chrome.browserName,
      });
    } finally {
      process.off('SIGINT', onSigint);
    }
  } catch (error) {
    launchSpinner.fail('Failed to start local run');
    throw error;
  } finally {
    // Step 4: Clean up — close tunnel and Chrome
    tunnel.close();
    chrome.kill();
    ctx.infra.ui.info('Browser session and tunnel closed.');
  }
}

/**
 * Show test details in the terminal.
 */
function showDetails(ctx: CliContext, test: Test): void {
  ctx.infra.ui.info(`\n  Name:      ${test.name}`);
  ctx.infra.ui.info(`  ID:        ${test.id}`);
  ctx.infra.ui.info(`  Platform:  ${test.platform || 'web'}`);
  ctx.infra.ui.info(`  Status:    ${test.status || 'active'}`);
  if (test.goal) {
    ctx.infra.ui.info(`  Goal:      ${test.goal}`);
  }
}

/**
 * Handle mobile test selection — detect running emulators/simulators
 * and let the user pick one to run the test on.
 *
 * Flow:
 *   1. Scan for running Android emulators (adb) and iOS simulators (xcrun)
 *   2. Show the list for user to select
 *   3. Dispatch the run with the selected device info
 */
export async function handleMobileTest(
  ctx: CliContext,
  workspaceId: string,
  testId: string,
  test: Test,
): Promise<void> {
  const { select } = await import('@inquirer/prompts');
  const { detectDevices } = await import('../../infrastructure/mobile/device.detector.js');

  const action = await select({
    message: `${test.name}`,
    choices: [
      { name: '📱  Run on device/emulator', value: 'device' },
      { name: '☁️  Run in cloud', value: 'cloud' },
      { name: '📋  View details', value: 'details' },
    ],
  });

  if (action === 'details') {
    showDetails(ctx, test);
    return;
  }

  if (action === 'cloud') {
    await runInCloud(ctx, workspaceId, testId, test.name, 'production');
    return;
  }

  // Detect running devices/emulators
  const deviceSpinner = ctx.infra.ui.spinner('Scanning for devices...');
  const { devices, diagnostics } = detectDevices();
  deviceSpinner.stop();

  if (!devices.length) {
    warnNoDevices(ctx, diagnostics);
    return;
  }

  // Let user pick a device
  const deviceId = await select({
    message: 'Select a device',
    choices: devices.map((d) => ({
      name: `${d.platform === 'ios' ? '🍎' : '🤖'}  ${d.name}  (${d.id.slice(0, 12)}...)`,
      value: d.id,
    })),
  });

  const device = devices.find((d) => d.id === deviceId);
  if (!device) return;

  // Step 1: Start Appium bridge — creates Appium session + Socket.IO connection
  // The bridge attaches to whatever app is currently open on the device.
  const { startAppiumBridge } = await import('../../infrastructure/mobile/appium.bridge.js');

  const bridgeSpinner = ctx.infra.ui.spinner(`Connecting to ${device.name} via Appium...`);
  let bridge;
  try {
    const token = await ctx.infra.auth.getToken();
    if (!token) throw new Error('Not authenticated');

    const config = await ctx.infra.config.loadGlobalConfig();
    bridge = await startAppiumBridge({
      apiBaseUrl: config.apiUrl,
      authToken: token.accessToken,
      deviceId: device.id,
      platform: device.platform,
      deviceName: device.name,
    });
    bridgeSpinner.succeed(
      `Connected to ${device.name} (session: ${bridge.sessionId.slice(0, 12)}...)`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
  } catch (error: any) {
    bridgeSpinner.fail(`Failed to connect: ${error.message}`);
    ctx.infra.ui.hint('Make sure Appium is running: `appium`');
    ctx.infra.ui.hint('Missing Appium or a driver? Run `traceback setup`.');
    return;
  }

  // Step 2: Dispatch the test run with the session_id.
  // The backend's mobile agent will send commands via Socket.IO,
  // and our bridge relays them to the device via Appium.
  const runSpinner = ctx.infra.ui.spinner(`Running "${test.name}" on ${device.name}...`);
  try {
    const result = await ctx.infra.api.post<{ run_id: string }>(
      `/api/v1/workspaces/${workspaceId}/tests/${testId}/run`,
      {
        environment: 'production',
        viewport: 'phone',
        session_id: bridge.sessionId,
        device_name: device.name,
      },
    );
    runSpinner.succeed(`Run started: ${result.data.run_id}`);
    ctx.infra.ui.info('Watch the test run on your device/emulator.');
    ctx.infra.ui.hint('Press Ctrl+C to stop.');

    // Keep alive while the agent controls the device
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        ctx.infra.ui.info('\nStopping...');
        resolve();
      });
      setTimeout(resolve, 300_000);
    });
  } catch (error) {
    runSpinner.fail('Failed to start mobile run');
    throw error;
  } finally {
    // Clean up Appium session and Socket.IO connection
    await bridge.close();
    ctx.infra.ui.info('Appium session closed.');
  }
}

/**
 * Live verify flow — the mobile path of `traceback tests` for a fresh,
 * natural-language goal rather than a saved test.
 *
 * Flow:
 *   1. Ask for the goal
 *   2. Detect running emulators/simulators and let the user pick one
 *      (the chosen device implies the platform)
 *   3. Run the same verify loop as `traceback mobile verify`
 */
async function handleMobileLiveVerify(ctx: CliContext, workspaceId: string): Promise<void> {
  const { input, select } = await import('@inquirer/prompts');
  const { detectDevices } = await import('../../infrastructure/mobile/device.detector.js');
  const { runMobileVerify } = await import('../mobile/verify.js');

  const goal = await input({
    message: 'What should the test verify?',
    required: true,
  });

  // Detect running devices — the chosen device implies the platform
  const deviceSpinner = ctx.infra.ui.spinner('Scanning for devices...');
  const { devices, diagnostics } = detectDevices();
  deviceSpinner.stop();

  if (!devices.length) {
    warnNoDevices(ctx, diagnostics);
    return;
  }

  // Always prompt, even with exactly one device detected — an explicit confirmation, not an
  // automatic pick, since a run started against the wrong device (a stale emulator, a
  // colleague's real phone) is much more surprising to undo than one extra keypress.
  const device = await select<MobileDevice>({
    message: 'Select a device',
    choices: devices.map((d) => ({
      name: `${d.platform === 'ios' ? '🍎' : '🤖'}  ${d.name}  (${d.id.slice(0, 12)}...)`,
      value: d,
    })),
  });

  await runMobileVerify(ctx, {
    workspaceId,
    goal,
    platform: device.platform,
    device,
  });
}
