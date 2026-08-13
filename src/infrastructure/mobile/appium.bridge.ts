/**
 * Appium Bridge — relays commands between the backend agent and a mobile device.
 *
 * The backend's mobile agent can't talk to devices directly. Instead:
 *   1. The CLI connects to the backend via Socket.IO
 *   2. The backend agent sends commands (tap, type, swipe, screenshot)
 *   3. This bridge receives those commands and executes them via Appium
 *   4. Results (screenshots and action outcomes) are sent back
 *
 * The bridge attaches to whatever app is currently open on the device —
 * it doesn't launch or install anything. The user opens their app first,
 * then the agent tests it.
 *
 * Requires: Appium server running (`appium` command) and a device/emulator.
 */

/* The mobile wire protocol is intentionally dynamic; the bridge is also the CLI's progress UI. */
/* eslint-disable no-console */

import { io, type Socket } from 'socket.io-client';
import http from 'http';
import { spawn, type ChildProcess, execSync } from 'child_process';
import fs from 'fs/promises';

const MAX_SCREENSHOT_BASE64_LENGTH = 8 * 1024 * 1024;

export interface AppiumBridgeOptions {
  /** Backend API base URL (e.g. http://localhost:8000/api/v1) */
  apiBaseUrl: string;
  /** CLI auth token (tb_xxx) */
  authToken: string;
  /** Device ID from adb/xcrun (e.g. emulator-5554, ABCD-1234) */
  deviceId: string;
  /** Platform: "android" or "ios" */
  platform: 'android' | 'ios';
  /** Device name for display */
  deviceName: string;
  /** Appium server URL (default: http://localhost:4723) */
  appiumUrl?: string;
}

export interface AppiumSession {
  /** The Socket.IO session ID assigned by the backend */
  sessionId: string;
  /** Appium session ID for WebDriver commands */
  appiumSessionId: string;
  /** Disconnect and clean up */
  close: () => Promise<void>;
}

/**
 * Start an Appium session and connect the bridge to the backend.
 *
 * This:
 *   1. Creates an Appium session that attaches to the current app on the device
 *   2. Connects to the backend via Socket.IO
 *   3. Listens for agent commands and relays them to Appium
 *   4. Returns the session ID for use in run requests
 */
export async function startAppiumBridge(opts: AppiumBridgeOptions): Promise<AppiumSession> {
  const appiumUrl = opts.appiumUrl || 'http://localhost:4723';
  let recordingProcess: ChildProcess | null = null;
  const recordingPath = `/tmp/traceback_recording_${opts.deviceId}.mp4`;

  // Step 1: Create an Appium session that attaches to the current foreground app.
  // We use autoLaunch=false so it doesn't launch a new app — just connects to whatever's open.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Appium capability values are a mixed bag of primitives
  const capabilities: Record<string, any> =
    opts.platform === 'android'
      ? {
          platformName: 'Android',
          'appium:automationName': 'UiAutomator2',
          'appium:udid': opts.deviceId,
          'appium:autoLaunch': false,
          'appium:noReset': true,
          // Attach to the current foreground app
          'appium:autoGrantPermissions': true,
        }
      : {
          platformName: 'iOS',
          'appium:automationName': 'XCUITest',
          'appium:udid': opts.deviceId,
          'appium:autoLaunch': false,
          'appium:noReset': true,
        };

  const sessionRes = await fetchJson(`${appiumUrl}/session`, {
    method: 'POST',
    body: JSON.stringify({
      capabilities: { alwaysMatch: capabilities },
    }),
  });

  const appiumSessionId = sessionRes?.value?.sessionId;
  if (!appiumSessionId) {
    throw new Error(
      'Failed to create Appium session — is Appium running and the device connected?',
    );
  }

  // Step 2: Connect to the backend via Socket.IO
  const socketUrl = opts.apiBaseUrl.replace(/\/api\/v1$/, '');
  const socket: Socket = io(socketUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token: opts.authToken },
    query: { token: opts.authToken },
    // Keep the connection alive — mobile runs can take minutes.
    // Without these, Socket.IO drops the connection after ~25s idle.
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 30_000,
  });

  const sessionId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket.IO connection timed out'));
    }, 15_000);

    socket.on('connect', () => {
      // Authenticate as a mobile CLI client
      socket.emit('cli_auth', {
        token: opts.authToken,
        type: 'mobile',
        platform: opts.platform,
        deviceId: opts.deviceId,
        skipAuth: false,
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io payload shape not modeled client-side
    socket.on('cli_authenticated', (data: any) => {
      clearTimeout(timeout);
      resolve(data.session_id);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io payload shape not modeled client-side
    socket.on('cli_error', (data: any) => {
      clearTimeout(timeout);
      reject(new Error(data.message || 'CLI authentication failed'));
    });

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`Socket.IO connection failed: ${err.message}`));
    });
  });

  // Step 3: Listen for agent commands and relay them to Appium
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- socket.io payload shape not modeled client-side
  socket.on('agent_command', async (data: any) => {
    const { request_id, command, data: cmdData } = data;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- result shape varies per command
      let result: any = {};

      switch (command) {
        case 'capture_state': {
          console.log('[Appium] Capturing screen state...');
          // Vision-only capture: never call `/source`. Maps and third-party widgets can make
          // the accessibility hierarchy slow or incomplete, while the screenshot is reliable.
          const screenshot = await fetchJson(`${appiumUrl}/session/${appiumSessionId}/screenshot`);
          const screenshotB64 = String(screenshot?.value || '');
          if (!screenshotB64 || screenshotB64.length > MAX_SCREENSHOT_BASE64_LENGTH) {
            throw new Error('Appium screenshot is empty or exceeds the transport limit');
          }
          result = {
            screenshot_b64: screenshotB64,
            media_type: 'image/png',
            url: '',
            title: '',
          };
          break;
        }

        case 'capture_page_source': {
          // Optional Set-of-Mark grounding fetch -- bounded so a slow/hung `/source` call on a
          // map, canvas surface, or React Native/Flutter screen with an incomplete accessibility
          // tree can never stall the perception loop. A timeout or any other failure resolves as
          // `{ page_source: '' }`, never an error, so the backend's own fallback (plain
          // pure-pixel reasoning, exactly today's behavior) always has a clean signal to act on.
          const timeoutMs = Math.round(Number(cmdData?.timeout_seconds ?? 1.2) * 1000);
          try {
            const source = await fetchJson(`${appiumUrl}/session/${appiumSessionId}/source`, {
              timeoutMs,
            });
            result = { page_source: String(source?.value || '') };
          } catch (e) {
            console.log(`[Appium] Set-of-Mark grounding fetch skipped: ${(e as Error).message}`);
            result = { page_source: '' };
          }
          break;
        }

        case 'get_screen_size': {
          const size = await fetchJson(`${appiumUrl}/session/${appiumSessionId}/window/size`);
          result = {
            width: Number(size?.value?.width || 400),
            height: Number(size?.value?.height || 800),
          };
          break;
        }

        case 'execute_action': {
          const { action, target, value, clear_first: clearFirst } = cmdData;
          console.log(
            `[Appium] ${action} → ${target?.what || 'coordinate target'}${
              value != null ? ' (value provided)' : ''
            }`,
          );
          result = await executeAppiumAction(
            appiumUrl,
            appiumSessionId,
            action,
            target,
            value,
            null,
            opts.platform,
            clearFirst !== false,
          );
          if (result.error) {
            console.log(`[Appium] ✗ ${result.error}`);
          } else {
            console.log(`[Appium] ✓ ${result.result}`);
          }
          break;
        }

        case 'goto': {
          // For mobile, "goto" means open a deep link or URL
          const url = cmdData.url || '';
          if (url.startsWith('http')) {
            await fetchJson(`${appiumUrl}/session/${appiumSessionId}/url`, {
              method: 'POST',
              body: JSON.stringify({ url }),
            });
          }
          result = { result: `Navigated to ${url}` };
          break;
        }
        
        case 'open_app': {
          const bundleId = cmdData.bundle_id || data.bundle_id;
          console.log(`[Appium] Opening app: ${bundleId}`);
          await fetchJson(`${appiumUrl}/session/${appiumSessionId}/appium/device/activate_app`, {
            method: 'POST',
            body: JSON.stringify({ appId: bundleId })
          });
          result = { result: `Opened app ${bundleId}` };
          break;
        }

        case 'close_app': {
          const bundleId = cmdData.bundle_id || data.bundle_id;
          console.log(`[Appium] Closing app: ${bundleId}`);
          await fetchJson(`${appiumUrl}/session/${appiumSessionId}/appium/device/terminate_app`, {
            method: 'POST',
            body: JSON.stringify({ appId: bundleId })
          });
          result = { result: `Closed app ${bundleId}` };
          break;
        }

        case 'open_url': {
          const url = cmdData.url || data.url;
          console.log(`[Native] Opening URL: ${url}`);
          if (opts.platform === 'ios') {
            execSync(`xcrun simctl openurl ${opts.deviceId} "${url}"`);
          } else {
            execSync(`adb -s ${opts.deviceId} shell am start -a android.intent.action.VIEW -d "${url}"`);
          }
          result = { result: `Opened URL ${url}` };
          break;
        }

        case 'simulate_fingerprint': {
          const fingerId = cmdData.finger_id || data.finger_id || 1;
          console.log(`[Appium] Simulating fingerprint ID: ${fingerId}`);
          await fetchJson(`${appiumUrl}/session/${appiumSessionId}/appium/device/finger_print`, {
            method: 'POST',
            body: JSON.stringify({ fingerprintId: fingerId })
          });
          result = { result: `Simulated fingerprint ${fingerId}` };
          break;
        }

        case 'wait_for_stable': {
          await new Promise((r) => setTimeout(r, 2000));
          result = { result: 'Waited for stable' };
          break;
        }

        case 'start_recording': {
          console.log('[Native] Starting screen recording...');
          try {
            // Delete any stale recording file
            await fs.unlink(recordingPath).catch(() => {});
            
            if (opts.platform === 'ios') {
              recordingProcess = spawn('xcrun', ['simctl', 'io', opts.deviceId, 'recordVideo', '--force', recordingPath]);
            } else {
              // Android: record to device sdcard first
              // We don't delete stale file on device for brevity, screenrecord overwrites by default usually, but we can rm it
              execSync(`adb -s ${opts.deviceId} shell rm -f /sdcard/traceback_recording.mp4 || true`);
              recordingProcess = spawn('adb', ['-s', opts.deviceId, 'shell', 'screenrecord', '/sdcard/traceback_recording.mp4']);
            }
            
            // Ignore stdout/stderr but keep process running
            recordingProcess.stdout?.on('data', () => {});
            recordingProcess.stderr?.on('data', () => {});
            
            result = { result: 'Started recording natively' };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (e: any) {
            console.error('[Native] Error starting recording:', e);
            result = { error: `Failed to start recording: ${e.message}` };
          }
          break;
        }

        case 'stop_recording': {
          console.log('[Native] Stopping screen recording...');
          if (recordingProcess) {
            // Send SIGINT so the recording finishes encoding properly
            recordingProcess.kill('SIGINT');
            
            // Wait for it to cleanly exit
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, 5000); // 5s fallback timeout
              recordingProcess!.on('exit', () => {
                clearTimeout(timeout);
                resolve();
              });
            });
            recordingProcess = null;
          } else {
            console.log('[Native] No recording process found');
          }
          
          try {
            if (opts.platform === 'android') {
              // Pull the file from Android sdcard
              execSync(`adb -s ${opts.deviceId} pull /sdcard/traceback_recording.mp4 ${recordingPath}`);
              execSync(`adb -s ${opts.deviceId} shell rm /sdcard/traceback_recording.mp4 || true`);
            }
            
            const videoBuffer = await fs.readFile(recordingPath);
            result = { video_b64: videoBuffer.toString('base64') };
            
            // Cleanup local file
            await fs.unlink(recordingPath).catch(() => {});
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (e: any) {
            console.error('[Native] Error retrieving recording:', e);
            result = { video_b64: '' };
          }
          
          break;
        }

        default:
          result = { error: `Unknown command: ${command}` };
      }

      // Send the result back to the backend agent
      socket.emit('agent_response', { request_id, data: result });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- command dispatch error shape not modeled client-side
    } catch (err: any) {
      socket.emit('agent_response', {
        request_id,
        data: { error: err.message || 'Command failed' },
      });
    }
  });

  // Step 4: Return the session for use in run requests
  return {
    sessionId,
    appiumSessionId,
    close: async () => {
      socket.disconnect();
      // End the Appium session
      try {
        await fetchJson(`${appiumUrl}/session/${appiumSessionId}`, { method: 'DELETE' });
      } catch {
        // Session might already be gone
      }
    },
  };
}

/**
 * Execute an action on the device via Appium.
 *
 * The active implementation is coordinate-only. The unused legacy locator parameter remains
 * solely for wire compatibility with older callers and is intentionally ignored.
 */
async function waitForStableScreen(base: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + Math.max(100, Math.min(timeoutMs, 5000));
  let previous = '';
  while (Date.now() < deadline) {
    const screenshot = await fetchJson(`${base}/screenshot`);
    const current = String(screenshot?.value || '');
    if (current && current === previous) return;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function pinchAt(base: string, x: number, y: number, scale: string): Promise<void> {
  if (scale !== 'in' && scale !== 'out') throw new Error("pinch scale must be 'in' or 'out'");
  const size = await fetchJson(`${base}/window/size`);
  const distance = Math.min(Number(size?.value?.width) || 1080, Number(size?.value?.height) || 1920) * 0.12;
  const direction = scale === 'in' ? 1 : -1;
  await fetchJson(`${base}/actions`, {
    method: 'POST',
    body: JSON.stringify({
      actions: [
        {
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(x - distance), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 100 },
            { type: 'pointerMove', duration: 350, x: Math.round(x - direction * distance), y: Math.round(y) },
            { type: 'pointerUp', button: 0 },
          ],
        },
        {
          type: 'pointer',
          id: 'finger2',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(x + distance), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 100 },
            { type: 'pointerMove', duration: 350, x: Math.round(x + direction * distance), y: Math.round(y) },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    }),
  });
}

async function clearActiveElement(base: string): Promise<void> {
  // Resolves whatever currently has focus via Appium's active-element endpoint -- no selector
  // involved, so this stays consistent with the vision-only design never holding a persisted
  // element reference across turns. Best-effort: a field that can't be cleared (or no element
  // currently focused) still gets typed into by the caller right after this.
  try {
    const active = await fetchJson(`${base}/element/active`);
    const elementId =
      active?.value?.ELEMENT || active?.value?.['element-6066-11e4-a52e-4f735466cecf'];
    if (elementId) {
      await fetchJson(`${base}/element/${elementId}/clear`, { method: 'POST', body: '{}' });
    }
  } catch {
    // Swallow -- clearing is an optional precursor to typing, never a hard requirement.
  }
}

async function executeAppiumAction(
  appiumUrl: string,
  sessionId: string,
  action: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any,
  value: string | null,
  _legacyResolved?: { strategy?: string; locator?: string } | null,
  platform?: 'android' | 'ios',
  clearFirst = true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const base = `${appiumUrl}/session/${sessionId}`;

  if (action === 'tap' || action === 'click') {
    if (target?.bounds) {
      let x, y;
      if (target.bounds.length === 2) {
        x = target.bounds[0];
        y = target.bounds[1];
      } else {
        x = target.bounds[0] + target.bounds[2] / 2;
        y = target.bounds[1] + target.bounds[3] / 2;
      }
      await fetchJson(`${base}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          actions: [{
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 50 },
              { type: 'pointerUp', button: 0 }
            ]
          }]
        })
      });
      return { result: `Tapped coordinates [${Math.round(x)}, ${Math.round(y)}]` };
    }

    return { error: 'Vision tap requires screenshot bounds [x, y]. Selectors are disabled.' };
  }

  if (action === 'type' || action === 'fill') {
    if (target?.bounds) {
      let x, y;
      if (target.bounds.length === 2) {
        x = target.bounds[0];
        y = target.bounds[1];
      } else {
        x = target.bounds[0] + target.bounds[2] / 2;
        y = target.bounds[1] + target.bounds[3] / 2;
      }
      // Tap first to focus
      await fetchJson(`${base}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          actions: [{
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 50 },
              { type: 'pointerUp', button: 0 }
            ]
          }]
        })
      });
      // Clearing after the tap-to-focus above and before typing is the common case: setting a
      // field's value, not appending to whatever it already held (confirmed live -- typing into
      // a pre-filled "My Location" field without clearing first produced concatenated garbage).
      if (clearFirst) {
        await clearActiveElement(base);
      }
      // Then type
      await fetchJson(`${base}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          actions: [{
            type: 'key',
            id: 'keyboard',
            actions: (value || '').split('').map(char => ({ type: 'keyDown', value: char }))
              .concat((value || '').split('').map(char => ({ type: 'keyUp', value: char })))
          }]
        })
      });
      return { result: `Typed '${value}' at coordinates [${Math.round(x)}, ${Math.round(y)}]` };
    }

    if (!target || Object.keys(target).length === 0) {
      // Type into active element
      if (clearFirst) {
        await clearActiveElement(base);
      }
      await fetchJson(`${base}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          actions: [{
            type: 'key',
            id: 'keyboard',
            actions: (value || '').split('').flatMap(char => [
                { type: 'keyDown', value: char },
                { type: 'keyUp', value: char }
            ])
          }]
        })
      });
      return { result: `Typed '${value}'` };
    }

    return { error: 'Vision type requires screenshot bounds [x, y]. Selectors are disabled.' };
  }

  if (action === 'long_press') {
    if (!target?.bounds || target.bounds.length !== 2) {
      return { error: 'Vision long_press requires coordinate bounds [x, y].' };
    }
    const [x, y] = target.bounds;
    await fetchJson(`${base}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        actions: [{
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: Math.max(100, Math.min(Number(value) || 800, 5000)) },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      }),
    });
    return { result: 'Long-pressed coordinate' };
  }

  if (action === 'pinch_zoom') {
    if (!target?.bounds || target.bounds.length !== 2) {
      return { error: 'Vision pinch_zoom requires coordinate bounds [x, y].' };
    }
    await pinchAt(base, Number(target.bounds[0]), Number(target.bounds[1]), String(value));
    return { result: `Pinched to zoom ${value}` };
  }

  if (action === 'wait' || action === 'wait_for_stable') {
    await waitForStableScreen(base, Number(value || 2000));
    return { result: 'Waited for visual stability' };
  }

  if (action === 'swipe' || action === 'scroll' || action === 'drag') {
    const direction = target?.context || 'down';
    const size = await fetchJson(`${base}/window/size`);
    const width = Number(size?.value?.width) || 1080;
    const height = Number(size?.value?.height) || 1920;

    let startX = target?.from_bounds?.[0];
    let startY = target?.from_bounds?.[1];
    let endX = target?.to_bounds?.[0];
    let endY = target?.to_bounds?.[1];
    if ([startX, startY, endX, endY].some((coordinate) => coordinate === undefined)) {
      const marginX = Math.round(width * 0.1);
      const marginY = Math.round(height * 0.15);
      startX = width / 2;
      startY = height / 2;
      endX = width / 2;
      endY = height / 2;
      if (direction === 'up') {
        startY = height - marginY;
        endY = marginY;
      } else if (direction === 'down') {
        startY = marginY;
        endY = height - marginY;
      } else if (direction === 'left') {
        startX = width - marginX;
        endX = marginX;
      } else if (direction === 'right') {
        startX = marginX;
        endX = width - marginX;
      }
    }

    await fetchJson(`${base}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        actions: [{
          type: 'pointer',
          id: 'finger1',
          parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: Math.round(startX), y: Math.round(startY) },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 100 },
            { type: 'pointerMove', duration: 250, x: Math.round(endX), y: Math.round(endY) },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      }),
    });
    return { result: `Swiped ${direction}` };
  }

  if (action === 'press_key') {
    const key = (value || '').toLowerCase();
    
    if (key === 'back') {
      await fetchJson(`${base}/back`, { method: 'POST', body: '{}' });
    } else if (key === 'home') {
      if (platform === 'ios') {
        await fetchJson(`${base}/execute/sync`, {
          method: 'POST',
          body: JSON.stringify({ script: 'mobile: pressButton', args: [{ name: 'home' }] })
        });
      } else {
        await fetchJson(`${base}/appium/device/press_keycode`, {
          method: 'POST',
          body: JSON.stringify({ keycode: 3 })
        });
      }
    } else if (key === 'power') {
      if (platform === 'ios') {
        await fetchJson(`${base}/appium/device/lock`, { method: 'POST', body: JSON.stringify({ seconds: 0 }) });
      } else {
        await fetchJson(`${base}/appium/device/press_keycode`, {
          method: 'POST',
          body: JSON.stringify({ keycode: 26 })
        });
      }
    }
    return { result: `Pressed ${value}` };
  }

  if (action === 'set_location') {
    if (target?.latitude !== undefined && target?.longitude !== undefined) {
      await fetchJson(`${base}/location`, {
        method: 'POST',
        body: JSON.stringify({
          location: {
            latitude: target.latitude,
            longitude: target.longitude,
            altitude: target.altitude || 0
          }
        })
      });
      return { result: `Set location to lat: ${target.latitude}, lon: ${target.longitude}` };
    }
    return { error: 'Missing latitude or longitude for set_location' };
  }

  return { error: `Unknown mobile action: ${action}` };
}

/**
 * Deprecated selector helpers retained for old non-agent callers; the vision action dispatcher
 * above never invokes them. They should be removed once legacy bridge consumers are gone.
 *
 * Find an element using Appium's WebDriver find strategies.
 * Tries accessibility id first, then text content, then xpath.
 */
/**
 * Find an element using Appium's WebDriver find strategies.
 *
 * iOS uses: accessibility id, name, label, value (via xpath or -ios predicate string)
 * Android uses: accessibility id, text, content-desc (via xpath)
 *
 * We try multiple strategies in order of reliability.
 */
/**
 * Find an element using multiple strategies with progressive simplification.
 *
 * The agent sends descriptions like "Add button to create a new contact"
 * but the actual iOS element label is just "Add". We try the full string
 * first, then progressively shorter/simpler versions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
async function findElement(baseUrl: string, target: any): Promise<string | null> {
  const what = target?.what || '';

  // Build a list of search terms — full string first, then simplified versions.
  // "Add button to create a new contact" → ["Add button to create a new contact", "Add button", "Add"]
  const searchTerms = buildSearchTerms(what);

  for (const term of searchTerms) {
    // Strategy 1: accessibility id (exact match)
    const byA11y = await tryFind(baseUrl, 'accessibility id', term);
    if (byA11y) return byA11y;

    // Strategy 2: name attribute
    const byName = await tryFind(baseUrl, 'name', term);
    if (byName) return byName;

    // Strategy 3: iOS predicate string (partial match across label, name, value)
    const safeTerm = term.replace(/"/g, '\\"');
    const predicate = `label CONTAINS "${safeTerm}" OR name CONTAINS "${safeTerm}" OR value CONTAINS "${safeTerm}"`;
    const byPredicate = await tryFind(baseUrl, '-ios predicate string', predicate);
    if (byPredicate) return byPredicate;
  }

  // Strategy 4: type-specific fallbacks
  const lowerWhat = what.toLowerCase();
  if (lowerWhat.includes('button') || lowerWhat.includes('tap') || lowerWhat.includes('click')) {
    // Try finding any button with a matching short label
    const shortLabel = what
      .replace(/\b(button|the|to|a|an|on|in)\b/gi, '')
      .trim()
      .split(/\s+/)[0];
    if (shortLabel) {
      const byBtn = await tryFind(
        baseUrl,
        '-ios predicate string',
        `type == "XCUIElementTypeButton" AND (label CONTAINS "${shortLabel}" OR name CONTAINS "${shortLabel}")`,
      );
      if (byBtn) return byBtn;
    }
  }
  if (lowerWhat.includes('field') || lowerWhat.includes('input') || lowerWhat.includes('text')) {
    // Extract the field name — "First name input field" → "First name"
    const fieldName = what.replace(/\b(input|field|text|the|into|enter)\b/gi, '').trim();
    if (fieldName) {
      const byField = await tryFind(
        baseUrl,
        '-ios predicate string',
        `(type == "XCUIElementTypeTextField" OR type == "XCUIElementTypeSecureTextField") AND (label CONTAINS "${fieldName}" OR name CONTAINS "${fieldName}" OR value CONTAINS "${fieldName}")`,
      );
      if (byField) return byField;
    }
    // Last resort: just find the first visible text field
    const anyField = await tryFind(
      baseUrl,
      'xpath',
      `(//XCUIElementTypeTextField | //XCUIElementTypeSecureTextField)[1]`,
    );
    if (anyField) return anyField;
  }

  return null;
}

/**
 * Build progressively shorter search terms from a description.
 * "Add button to create a new contact" → ["Add button to create a new contact", "Add button", "Add"]
 * "First name input field" → ["First name input field", "First name", "First"]
 */
function buildSearchTerms(what: string): string[] {
  const terms = [what];

  // Remove common filler words and try the shorter version
  const stripped = what
    .replace(
      /\b(to|the|a|an|that|this|into|from|with|for|on|in|of|is|are|was|were|button|field|input|text)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped && stripped !== what) {
    terms.push(stripped);
  }

  // Try just the first 1-2 significant words
  const words = what
    .replace(/\b(the|a|an|to|tap|click|enter|type)\b/gi, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 1) {
    terms.push(words.slice(0, 2).join(' '));
  }
  const firstWord = words[0];
  if (firstWord && !terms.includes(firstWord)) {
    terms.push(firstWord);
  }

  // Deduplicate
  return [...new Set(terms)];
}

async function tryFind(baseUrl: string, strategy: string, value: string): Promise<string | null> {
  try {
    const result = await fetchJson(`${baseUrl}/element`, {
      method: 'POST',
      body: JSON.stringify({ using: strategy, value }),
    });
    const el = result?.value?.ELEMENT || result?.value?.['element-6066-11e4-a52e-4f735466cecf'];
    return el || null;
  } catch {
    return null;
  }
}

/**
 * Simple fetch wrapper for Appium WebDriver HTTP API.
 *
 * `timeoutMs`, when given, bounds this one request and rejects on expiry instead of hanging --
 * used by the optional Set-of-Mark grounding fetch (`/source` can be slow or hang on maps,
 * canvas surfaces, and React Native/Flutter screens with an incomplete accessibility tree, which
 * is exactly why the vision-only agent never called it unconditionally). Every other call site
 * omits it and keeps today's unbounded behavior.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic WebDriver JSON response shape not modeled client-side
async function fetchJson(
  url: string,
  options?: { method?: string; body?: string; timeoutMs?: number },
): Promise<any> {
  return await new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options?.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', reject);
    if (options?.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error(`Appium request timed out after ${options.timeoutMs}ms`));
      });
    }
    if (options?.body) req.write(options.body);
    req.end();
  });
}
