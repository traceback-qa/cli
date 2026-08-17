/**
 * Mobile verify runner — starts one local Appium bridge and lets the backend's
 * Socket.IO mobile agent own the full observe/decide/act loop.
 *
 * The device bridge is persistent for the lifetime of the run:
 *   CLI ↔ Socket.IO ↔ backend mobile agent ↔ Socket.IO ↔ Appium
 *
 * The bridge attaches to whatever app is currently open on the selected device.
 */

import type { CliContext } from '../../types/context.js';
import type { MobileDevice } from '../../infrastructure/mobile/device.detector.js';
import { startAppiumBridge, type AppiumSession } from '../../infrastructure/mobile/appium.bridge.js';
import { ensureAppiumServer, type AppiumServerHandle } from '../../infrastructure/mobile/appium.server.js';
import {
  connectAppiumTunnel,
  type AppiumTunnelHandle,
} from '../../infrastructure/tunnel/appium-proxy/appium-tunnel.client.js';
import { watchRun } from '../../infrastructure/socket/run-events.client.js';

export const DEFAULT_APPIUM_URL = 'http://localhost:4723';

export interface MobileVerifyOptions {
  workspaceId: string;
  goal: string;
  platform: 'android' | 'ios';
  device: MobileDevice;
  appiumUrl?: string;
  appPath?: string | null;
  osVersion?: string | null;
  appPackage?: string | null;
  appActivity?: string | null;
  deepLink?: string | null;
  /**
   * Experimental: skip the accessibility-tree fetch entirely and target the screen by raw
   * pixel coordinates instead of numbered Set-of-Mark elements. Exists because /source proved
   * unreliably slow on XCUITest against screens with complex native views (a live MapView).
   */
  visionMode?: boolean;
}

/** Run one natural-language verification through the persistent Socket.IO path. */
export async function runMobileVerify(ctx: CliContext, opts: MobileVerifyOptions): Promise<void> {
  const { api, auth, config: configService, ui } = ctx.infra;
  const token = await auth.getToken();
  if (!token) {
    ui.error('Not authenticated. Run `traceback login` first.');
    return;
  }

  const config = await configService.loadGlobalConfig();
  let bridge: AppiumSession | null = null;
  let appiumTunnel: AppiumTunnelHandle | null = null;
  let appiumServer: AppiumServerHandle | null = null;

  const appiumUrl = opts.appiumUrl || DEFAULT_APPIUM_URL;
  const serverSpinner = ui.spinner('Starting Appium...');
  try {
    appiumServer = await ensureAppiumServer(appiumUrl);
    serverSpinner.succeed(appiumServer.spawned ? 'Appium started' : 'Appium already running');
  } catch (error) {
    serverSpinner.fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const bridgeSpinner = ui.spinner(`Connecting to ${opts.device.name} via Appium...`);
  try {
    bridge = await startAppiumBridge({
      apiBaseUrl: config.apiUrl,
      authToken: token.accessToken,
      deviceId: opts.device.id,
      platform: opts.platform,
      deviceName: opts.device.name,
      appiumUrl,
    });
  } catch (error) {
    bridgeSpinner.fail(`Failed to connect: ${error instanceof Error ? error.message : String(error)}`);
    ui.hint('Missing an Appium driver? Run `traceback setup`.');
    await appiumServer.stop();
    return;
  }

  // Also open the generic Appium HTTP tunnel, workspace-scoped (not session-scoped
  // like the bridge above) -- additive, same as the Pre-made-test path in
  // commands/tests/index.ts. Separate try/catch so a tunnel failure closes the
  // already-open bridge instead of leaking a live Appium session on the device.
  try {
    appiumTunnel = await connectAppiumTunnel({
      apiBaseUrl: config.apiUrl,
      authToken: token.accessToken,
      workspaceId: opts.workspaceId,
      appiumUrl,
    });
  } catch (error) {
    bridgeSpinner.fail(
      `Failed to open Appium tunnel: ${error instanceof Error ? error.message : String(error)}`,
    );
    await bridge.close();
    await appiumServer.stop();
    return;
  }

  bridgeSpinner.succeed(
    `Connected to ${opts.device.name} (socket: ${bridge.sessionId.slice(0, 12)}...)`,
  );

  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
    ui.info('\nStopping the mobile run and closing the Appium session...');
    controller.abort();
  };
  process.once('SIGINT', onInterrupt);

  try {
    const runSpinner = ui.spinner(`Starting mobile run on ${opts.device.name}...`);
    let runId: string;
    try {
      const result = await api.post<{ run_id: string; goal: string }>(
        `/api/v1/workspaces/${opts.workspaceId}/mcp/mobile-start`,
        {
          goal: opts.goal,
          platform: opts.platform,
          trigger_type: 'CLI',
          device_name: opts.device.name,
          session_id: bridge.sessionId,
          vision_mode: opts.visionMode ?? false,
        },
      );
      runId = result.data.run_id;
      runSpinner.succeed(`Run started: ${runId}`);
    } catch (error) {
      runSpinner.fail(`Failed to start run: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    ui.info(`\nRunning: "${opts.goal.slice(0, 100)}${opts.goal.length > 100 ? '...' : ''}"\n`);
    ui.hint('Agent decisions and Appium actions stream below. Press Ctrl+C to stop.');
    await watchRun(config.apiUrl, token.accessToken, runId, ui, controller.signal);

    if (interrupted) {
      ui.warn('Mobile run stopped. The Appium session has been closed.');
    }
  } catch (error) {
    if (!interrupted) {
      ui.error(`Mobile run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    controller.abort();
    appiumTunnel?.close();
    if (bridge) {
      await bridge.close();
      ui.info('Appium session closed.');
    }
    if (appiumServer?.spawned) {
      await appiumServer.stop();
      ui.info('Appium server stopped.');
    }
  }
}
