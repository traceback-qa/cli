/**
 * Chrome Launcher — finds and launches Chrome with CDP enabled.
 *
 * When the user runs a test locally, we need to:
 *   1. Find Chrome/Chromium on their system
 *   2. Launch it with --remote-debugging-port so we can control it via CDP
 *   3. Discover the CDP WebSocket URL from Chrome's /json/version endpoint
 *
 * The backend agent then connects to this CDP URL through the tunnel
 * and runs test steps in the user's actual browser.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';

const CDP_PORT = 9222;

/** Known Chrome/Chromium paths per platform. */
const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

/**
 * Find the Chrome/Chromium executable on the user's system.
 */
function findChrome(): string | null {
  const candidates = CHROME_PATHS[process.platform] || [];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return null;
}

/**
 * Fetch the CDP WebSocket URL from Chrome's debug endpoint.
 *
 * Chrome exposes http://localhost:{port}/json/version when launched with
 * --remote-debugging-port. The response contains `webSocketDebuggerUrl`
 * which is the CDP endpoint we give to Playwright.
 */
async function getCdpUrl(port: number = CDP_PORT, retries: number = 20): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.webSocketDebuggerUrl) {
                resolve(json.webSocketDebuggerUrl);
              } else {
                reject(new Error('No webSocketDebuggerUrl in response'));
              }
            } catch {
              reject(new Error('Invalid JSON from Chrome'));
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });

      if (url) return url;
    } catch {
      // Chrome might not be ready yet — wait and retry
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error(`Could not connect to Chrome on port ${port} after ${retries} attempts`);
}

export interface LaunchedChrome {
  /** The Chrome child process. */
  process: ChildProcess;
  /** The CDP WebSocket URL (e.g. ws://127.0.0.1:9222/devtools/browser/xxx). */
  cdpUrl: string;
  /** Kill the Chrome process. */
  kill: () => void;
}

/**
 * Launch Chrome with CDP enabled and return the CDP WebSocket URL.
 *
 * This opens a real Chrome window on the user's machine. The agent
 * will control it via CDP — the user can watch the test run live.
 *
 * Uses a temporary user-data-dir so it doesn't conflict with any
 * existing Chrome session the user might have open.
 */
export interface LaunchChromeOptions {
  port?: number;
  headed?: boolean;
}

export async function launchChrome(
  optionsOrPort: LaunchChromeOptions | number = CDP_PORT,
): Promise<LaunchedChrome> {
  const port = typeof optionsOrPort === 'number' ? optionsOrPort : (optionsOrPort.port ?? CDP_PORT);

  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error('Chrome not found. Install Google Chrome and try again.');
  }

  const tempProfile = join(tmpdir(), `traceback-chrome-${Date.now()}`);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-startup-window',
    '--window-size=1920,1080',
    '--window-position=0,0',
  ];

  const chromeProcess = spawn(chromePath, args, {
    stdio: 'ignore',
    detached: false,
  });

  // If Chrome crashes immediately, catch it
  chromeProcess.on('error', (err) => {
    throw new Error(`Failed to start Chrome: ${err.message}`);
  });

  // Wait for Chrome to start and discover the CDP URL
  const cdpUrl = await getCdpUrl(port);

  return {
    process: chromeProcess,
    cdpUrl,
    kill: () => {
      try {
        chromeProcess.kill();
      } catch {
        /* already dead */
      }
    },
  };
}
