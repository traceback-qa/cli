/**
 * Appium Server Lifecycle — starts a local `appium` server if one isn't already
 * running, and stops it again once the test/verify run that needed it is done.
 *
 * Mirrors `infrastructure/browser/chrome.launcher.ts`'s shape: spawn, poll a
 * status endpoint until ready, return a handle with a `stop()`/`kill()`.
 *
 * Crucially, `ensureAppiumServer()` only stops the process it itself spawned.
 * If the user already has `appium` running in another terminal (their own
 * long-lived server, shared across many local runs), we detect that via the
 * same `/status` probe and leave it alone — `stop()` becomes a no-op so we
 * never yank a server out from under a session the user didn't ask us to own.
 */

import { spawn, type ChildProcess } from 'child_process';
import http from 'http';

const DEFAULT_APPIUM_URL = 'http://localhost:4723';
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 500;

export interface AppiumServerHandle {
  /** True if this call actually spawned a new Appium process (false if one was already up). */
  spawned: boolean;
  /** Stop the server -- a no-op if we didn't spawn it ourselves. */
  stop: () => Promise<void>;
}

/** GET {appiumUrl}/status -- Appium's own health endpoint, returns 200 once ready to accept sessions. */
async function isAppiumUp(appiumUrl: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const req = http.get(`${appiumUrl}/status`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForAppium(appiumUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAppiumUp(appiumUrl)) return;
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`Appium did not become ready on ${appiumUrl} within ${timeoutMs}ms`);
}

/**
 * Ensure an Appium server is running at `appiumUrl`, starting one if needed.
 *
 * Call `stop()` when the mobile run is done (success, failure, or interrupt) --
 * same finally-block pattern already used for `bridge.close()`/`appiumTunnel.close()`
 * at every call site.
 */
export async function ensureAppiumServer(
  appiumUrl: string = DEFAULT_APPIUM_URL,
): Promise<AppiumServerHandle> {
  if (await isAppiumUp(appiumUrl)) {
    // Already running (the user's own long-lived server, or a previous unclean
    // shutdown left one alive) -- use it, don't touch its lifecycle.
    return { spawned: false, stop: async () => {} };
  }

  let appiumProcess: ChildProcess;
  try {
    appiumProcess = spawn('appium', [], { stdio: 'ignore', detached: false });
  } catch (err) {
    throw new Error(
      `Failed to start Appium: ${err instanceof Error ? err.message : String(err)}. ` +
        'Run `traceback setup` to install it.',
    );
  }

  const spawnError = new Promise<never>((_, reject) => {
    appiumProcess.on('error', (err) => {
      reject(
        new Error(
          `Failed to start Appium: ${err.message}. Is it installed? Run \`traceback setup\`.`,
        ),
      );
    });
    appiumProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`Appium exited immediately with code ${code}.`));
      }
    });
  });

  await Promise.race([waitForAppium(appiumUrl, READY_TIMEOUT_MS), spawnError]);

  return {
    spawned: true,
    stop: async () => {
      try {
        appiumProcess.kill();
      } catch {
        /* already dead */
      }
    },
  };
}
