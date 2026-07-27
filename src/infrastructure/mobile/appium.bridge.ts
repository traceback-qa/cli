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
          // Only the UI hierarchy is used server-side today — the screenshot isn't consumed
          // anywhere yet (no visual-regression/recording pipeline for mobile), so skip fetching
          // and JSON-parsing that multi-MB base64 payload on every single step. Add it back once
          // something actually reads screenshot_b64.
          // eslint-disable-next-line no-console -- direct user-facing terminal output for live progress
          console.log('[Appium] Capturing screen state...');
          const source = await fetchJson(`${appiumUrl}/session/${appiumSessionId}/source`);
          result = {
            screenshot_b64: '',
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
          );
          if (result.error) {
            console.log(`[Appium] ✗ ${result.error}`);
          } else {
            console.log(`[Appium] ✓ ${result.result}`);
          }
          /* eslint-enable no-console */
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

        case 'wait_for_stable': {
          await new Promise((r) => setTimeout(r, 2000));
          result = { result: 'Waited for stable' };
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
): Promise<any> {
  const base = `${appiumUrl}/session/${sessionId}`;

  if (action === 'tap' || action === 'click') {
    const element = resolved?.strategy
      ? await tryFind(base, resolved.strategy, resolved.locator!)
      : await findElement(base, target);
    if (!element) return { error: `Element not found: ${target?.what || 'unknown'}` };
    await fetchJson(`${base}/element/${element}/click`, { method: 'POST', body: '{}' });
    return { result: `Tapped ${target?.what || 'element'}` };
  }

  if (action === 'type' || action === 'fill') {
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
    // Press a key (e.g. Enter, Back)
    if (value === 'Back' || value === 'back') {
      await fetchJson(`${base}/back`, { method: 'POST', body: '{}' });
    }
    return { result: `Pressed ${value}` };
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
