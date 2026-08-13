/**
 * Appium Bridge — relays commands between the backend agent and a mobile device.
 *
 * The backend's mobile agent can't talk to devices directly. Instead:
 *   1. The CLI connects to the backend via Socket.IO
 *   2. The backend agent sends commands (tap, type, swipe, screenshot)
 *   3. This bridge receives those commands and executes them via Appium
 *   4. Results (screenshots, UI trees, action outcomes) are sent back
 *
 * The bridge attaches to whatever app is currently open on the device —
 * it doesn't launch or install anything. The user opens their app first,
 * then the agent tests it.
 *
 * Requires: Appium server running (`appium` command) and a device/emulator.
 */

import { io, type Socket } from 'socket.io-client';
import http from 'http';
import { spawn, type ChildProcess, execSync } from 'child_process';
import fs from 'fs/promises';

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
          // eslint-disable-next-line no-console -- direct user-facing terminal output for live progress
          console.log('[Appium] Capturing screen state...');
          const source = await fetchJson(`${appiumUrl}/session/${appiumSessionId}/source`);
          const screenshot = await fetchJson(`${appiumUrl}/session/${appiumSessionId}/screenshot`);
          result = {
            screenshot_b64: screenshot?.value || '',
            tree: source?.value || '',
            url: '',
            title: '',
          };
          break;
        }

        case 'execute_action': {
          const { action, target, value, resolved } = cmdData;
          /* eslint-disable no-console -- direct user-facing terminal output for live action progress */
          console.log(
            `[Appium] ${action} → ${target?.what || 'no target'} (value: ${value || 'none'})`,
          );
          if (resolved?.strategy) {
            console.log(`[Appium] LLM resolved: ${resolved.strategy} = "${resolved.locator}"`);
          }
          result = await executeAppiumAction(
            appiumUrl,
            appiumSessionId,
            action,
            target,
            value,
            resolved,
            opts.platform
          );
          if (result.error) {
            console.log(`[Appium] ✗ ${result.error}`);
          } else {
            console.log(`[Appium] ✓ ${result.result}`);
          }
          /* eslint-enable no-console */
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
 * Execute a single action on the device via Appium WebDriver.
 */
/**
 * Execute an action on the device via Appium.
 *
 * If `resolved` is provided (from the LLM element resolver), it contains
 * a precise Appium locator (strategy + value). This is much more reliable
 * than trying to match element descriptions with string manipulation.
 */
async function executeAppiumAction(
  appiumUrl: string,
  sessionId: string,
  action: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- target descriptor shape varies by action type
  target: any,
  value: string | null,
  resolved?: { strategy?: string; locator?: string } | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- result shape varies by action type
  platform?: 'android' | 'ios',
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

    const element = resolved?.strategy
      ? await tryFind(base, resolved.strategy, resolved.locator!)
      : await findElement(base, target);
    if (!element) return { error: `Element not found: ${target?.what || 'unknown'}` };
    await fetchJson(`${base}/element/${element}/click`, { method: 'POST', body: '{}' });
    return { result: `Tapped ${target?.what || 'element'}` };
  }

  if (action === 'long_press') {
    if (!target?.bounds) return { error: 'Long-press target has no coordinates' };
    const [x, y] = target.bounds.length === 2
      ? target.bounds
      : [target.bounds[0] + target.bounds[2] / 2, target.bounds[1] + target.bounds[3] / 2];
    const duration = Math.max(300, Number(value || 800));
    await fetchJson(`${base}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration },
          { type: 'pointerUp', button: 0 },
        ] }],
      }),
    });
    return { result: `Long-pressed coordinates [${Math.round(x)}, ${Math.round(y)}] for ${duration}ms` };
  }

  if (action === 'drag') {
    const from = target?.from_bounds;
    const to = target?.to_bounds;
    if (!from || !to) return { error: 'Drag target has no start/end coordinates' };
    await fetchJson(`${base}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(from[0]), y: Math.round(from[1]) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 500, x: Math.round(to[0]), y: Math.round(to[1]) },
          { type: 'pointerUp', button: 0 },
        ] }],
      }),
    });
    return { result: `Dragged from [${from[0]}, ${from[1]}] to [${to[0]}, ${to[1]}]` };
  }

  if (action === 'pinch') {
    const bounds = target?.bounds;
    const [x, y] = bounds?.length === 2 ? bounds : bounds ? [bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2] : [undefined, undefined];
    const zoomIn = value === 'in';
    const script = platform === 'ios' ? 'mobile: pinch' : zoomIn ? 'mobile: pinchOpenGesture' : 'mobile: pinchCloseGesture';
    const args = platform === 'ios' ? [{ scale: zoomIn ? 2 : 0.5, velocity: 1 }] : [{ ...(x !== undefined && y !== undefined ? { x: Math.round(x), y: Math.round(y) } : {}), percent: 0.5, steps: 20 }];
    await fetchJson(`${base}/execute/sync`, { method: 'POST', body: JSON.stringify({ script, args }) });
    return { result: `Pinched ${zoomIn ? 'in' : 'out'}` };
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

    const element = resolved?.strategy
      ? await tryFind(base, resolved.strategy, resolved.locator!)
      : await findElement(base, target);
    if (!element) return { error: `Element not found: ${target?.what || 'unknown'}` };
    await fetchJson(`${base}/element/${element}/clear`, { method: 'POST', body: '{}' });
    await fetchJson(`${base}/element/${element}/value`, {
      method: 'POST',
      body: JSON.stringify({ text: value || '' }),
    });
    return { result: `Typed '${value}' into ${target?.what || 'element'}` };
  }

  if (action === 'swipe' || action === 'scroll') {
    const direction = target?.context || 'down';
    // Use Appium's mobile:scroll gesture
    await fetchJson(`${base}/execute/sync`, {
      method: 'POST',
      body: JSON.stringify({
        script: 'mobile:scroll',
        args: [{ direction }],
      }),
    });
    return { result: `Scrolled ${direction}` };
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- target descriptor shape varies by action type
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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic WebDriver JSON response shape not modeled client-side
async function fetchJson(url: string, options?: { method?: string; body?: string }): Promise<any> {
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
    if (options?.body) req.write(options.body);
    req.end();
  });
}
