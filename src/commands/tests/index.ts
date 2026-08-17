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
import type { MobileDevice } from '../../infrastructure/mobile/device.detector.js';

type ContextGetter = typeof GetContextFn;

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

      // Step 1.5 (mobile only): pre-made test, or a live verify against a device
      if (platform === 'mobile') {
        const mode = await select({
          message: 'How do you want to run the mobile test?',
          choices: [
            {
              name: '📋  Pre-made test',
              value: 'premade',
              description: 'Pick a saved test from your workspace',
            },
            {
              name: '🎯  Live verify',
              value: 'live',
              description: 'Describe what to verify, pick a device, and run it now',
            },
          ],
        });
        if (mode === 'live') {
          await handleMobileLiveVerify(ctx, workspaceId);
          return;
        }
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
        spinner.fail('Failed to fetch tests');
        throw error;
      }

      if (!tests.length) {
        ctx.infra.ui.warn(`No ${platform} tests found in this workspace.`);
        return;
      }

      // Step 3: Let the user pick a test
      const testId = await select({
        message: `Select a ${platform} test`,
        choices: tests.map((t) => ({
          name: `${t.name}${t.goal ? `  —  ${t.goal.slice(0, 50)}` : ''}`,
          value: t.id,
        })),
      });

      const selected = tests.find((t) => t.id === testId);
      if (!selected) return;

      // Step 4: Run the selected test
      if (platform === 'mobile') {
        // ── Mobile: detect devices, let user pick one ──
        await handleMobileTest(ctx, workspaceId, testId, selected);
      } else {
        // ── Web: environment (if applicable), then straight into a cloud run --
        // no cloud/local/details menu in between. `runInCloud` itself asks "Watch this run
        // live?" and streams events when the answer is yes. Local Chrome (CDP tunnel) and the
        // static details view still exist (`runLocally`/`showDetails` below) for whatever picks
        // them back up later -- they're just not reachable from this flow anymore.
        const envs = Object.keys(selected.environments || {});
        // A single-choice select prompt has nothing to actually decide -- it just makes the
        // user press Enter through a list with one item in it, which reads as "did this even
        // ask me anything?" rather than a real environment choice. Only prompt when there's
        // more than one to pick between; with exactly one, use it directly and say so.
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

        await runInCloud(ctx, workspaceId, testId, selected.name, environment);
      }
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
    await watchRun(config.apiUrl, token.accessToken, runId, ctx.infra.ui, controller.signal);
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

  // Step 1: Launch Chrome with CDP enabled
  const chromeSpinner = ctx.infra.ui.spinner('Launching Chrome...');
  let chrome;
  try {
    chrome = await launchChrome();
    chromeSpinner.succeed(`Chrome launched (CDP: ${chrome.cdpUrl.slice(0, 40)}...)`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
  } catch (error: any) {
    chromeSpinner.fail(`Failed to launch Chrome: ${error.message}`);
    return;
  }

  // Step 2: Connect tunnel to backend and advertise the CDP URL
  const tunnelSpinner = ctx.infra.ui.spinner('Connecting tunnel...');
  let tunnel;
  try {
    const token = await ctx.infra.auth.getToken();
    if (!token) throw new Error('Not authenticated');

    const config = await ctx.infra.config.loadGlobalConfig();
    tunnel = await connectTunnel(config.apiUrl, token.accessToken, chrome.cdpUrl);
    tunnelSpinner.succeed(`Tunnel connected (${tunnel.tunnelId.slice(0, 12)}...)`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
  } catch (error: any) {
    tunnelSpinner.fail(`Tunnel failed: ${error.message}`);
    chrome.kill();
    return;
  }

  // Step 3: Dispatch the test run with the tunnel_id
  const runSpinner = ctx.infra.ui.spinner(`Running "${testName}" locally...`);
  try {
    const result = await ctx.infra.api.post<{ run_id: string }>(
      `/api/v1/workspaces/${workspaceId}/tests/${testId}/run`,
      {
        environment,
        viewport: 'desktop',
        tunnel_id: tunnel.tunnelId,
      },
    );
    runSpinner.succeed(`Run started: ${result.data.run_id}`);
    ctx.infra.ui.info('Watch the test run in your Chrome window.');
    ctx.infra.ui.hint('Press Ctrl+C to stop.');

    // Keep the process alive while the test runs.
    // The backend controls Chrome via CDP through our tunnel.
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        ctx.infra.ui.info('\nStopping...');
        resolve();
      });
      // Auto-resolve after 5 minutes (safety timeout)
      setTimeout(resolve, 300_000);
    });
  } catch (error) {
    runSpinner.fail('Failed to start local run');
    throw error;
  } finally {
    // Step 4: Clean up — close tunnel and Chrome
    tunnel.close();
    chrome.kill();
    ctx.infra.ui.info('Chrome and tunnel closed.');
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
async function handleMobileTest(
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
  const devices = detectDevices();
  deviceSpinner.stop();

  if (!devices.length) {
    ctx.infra.ui.warn('No running emulators or simulators found.');
    ctx.infra.ui.hint('Start an Android emulator or iOS simulator and try again.');
    ctx.infra.ui.hint('  Android: `emulator -avd <name>` or open Android Studio');
    ctx.infra.ui.hint('  iOS:     `open -a Simulator` or open Xcode');
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

  // Step 0: Ensure a local Appium server is running (start one if not).
  const { ensureAppiumServer } = await import('../../infrastructure/mobile/appium.server.js');
  const { DEFAULT_APPIUM_URL } = await import('../mobile/verify.js');

  const serverSpinner = ctx.infra.ui.spinner('Starting Appium...');
  let appiumServer;
  try {
    appiumServer = await ensureAppiumServer(DEFAULT_APPIUM_URL);
    serverSpinner.succeed(appiumServer.spawned ? 'Appium started' : 'Appium already running');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic startup error shape
  } catch (error: any) {
    serverSpinner.fail(error.message);
    return;
  }

  // Step 1: Start Appium bridge — creates Appium session + Socket.IO connection
  // The bridge attaches to whatever app is currently open on the device.
  const { startAppiumBridge } = await import('../../infrastructure/mobile/appium.bridge.js');

  const bridgeSpinner = ctx.infra.ui.spinner(`Connecting to ${device.name} via Appium...`);
  let bridge;
  let appiumTunnel;
  let token;
  let config;
  try {
    token = await ctx.infra.auth.getToken();
    if (!token) throw new Error('Not authenticated');

    config = await ctx.infra.config.loadGlobalConfig();
    bridge = await startAppiumBridge({
      apiBaseUrl: config.apiUrl,
      authToken: token.accessToken,
      deviceId: device.id,
      platform: device.platform,
      deviceName: device.name,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
  } catch (error: any) {
    bridgeSpinner.fail(`Failed to connect: ${error.message}`);
    ctx.infra.ui.hint('Missing an Appium driver? Run `traceback setup`.');
    await appiumServer.stop();
    return;
  }

  // Step 1.5: Also open the generic Appium HTTP tunnel, workspace-scoped (not
  // session-scoped like the bridge above). This holds a line open that lets any
  // raw Appium/WebDriver call reach this device's local Appium server via
  // POST /api/v1/workspaces/{workspaceId}/appium-tunnel/proxy/... — additive to
  // the structured bridge above, not a replacement for it. Separate try/catch so
  // a tunnel failure closes the already-open bridge instead of leaking a live
  // Appium session on the device.
  try {
    const { connectAppiumTunnel } = await import(
      '../../infrastructure/tunnel/appium-proxy/appium-tunnel.client.js'
    );
    appiumTunnel = await connectAppiumTunnel({
      apiBaseUrl: config.apiUrl,
      authToken: token.accessToken,
      workspaceId,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios error shape not modeled client-side
  } catch (error: any) {
    bridgeSpinner.fail(`Failed to open Appium tunnel: ${error.message}`);
    await bridge.close();
    await appiumServer.stop();
    return;
  }

  bridgeSpinner.succeed(
    `Connected to ${device.name} (session: ${bridge.sessionId.slice(0, 12)}...)`,
  );

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
    // Clean up Appium session, Socket.IO connection, the HTTP tunnel, and (if we
    // started it) the Appium server itself.
    await bridge.close();
    appiumTunnel?.close();
    ctx.infra.ui.info('Appium session closed.');
    if (appiumServer.spawned) {
      await appiumServer.stop();
      ctx.infra.ui.info('Appium server stopped.');
    }
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
  const devices = detectDevices();
  deviceSpinner.stop();

  if (!devices.length) {
    ctx.infra.ui.warn('No running emulators or simulators found.');
    ctx.infra.ui.hint('Start an Android emulator or iOS simulator and try again.');
    ctx.infra.ui.hint('  Android: `emulator -avd <name>` or open Android Studio');
    ctx.infra.ui.hint('  iOS:     `open -a Simulator` or open Xcode');
    return;
  }

  let device: MobileDevice;
  if (devices.length === 1) {
    device = devices[0]!;
    ctx.infra.ui.info(`Running against: ${device.name} (${device.id})`);
  } else {
    device = await select<MobileDevice>({
      message: 'Select a device',
      choices: devices.map((d) => ({
        name: `${d.platform === 'ios' ? '🍎' : '🤖'}  ${d.name}  (${d.id.slice(0, 12)}...)`,
        value: d,
      })),
    });
  }

  await runMobileVerify(ctx, {
    workspaceId,
    goal,
    platform: device.platform,
    device,
  });
}
