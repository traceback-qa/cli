/**
 * Chrome Launcher — finds and launches a Chromium-based browser with CDP enabled.
 *
 * When the user runs a test locally, we:
 *   1. Discover the user's default Chromium browser (Brave, Chrome, Edge, Arc, etc.)
 *   2. Fall back to any installed Chromium browser if the default is Safari/Firefox
 *   3. Inform the user if no Chromium browser is installed
 *   4. Launch it with --remote-debugging-port to control it via CDP
 *   5. Discover the CDP WebSocket URL from the browser's /json/version endpoint
 *
 * The backend agent connects to this CDP URL through the tunnel
 * and runs test steps in the user's actual browser.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import http from 'http';

const CDP_PORT = 9222;

interface ChromiumAppDef {
  name: string;
  bundleIds: string[];
  darwinExecs: string[];
  linuxExecs?: string[];
  winExecs?: string[];
}

const CHROMIUM_APPS: ChromiumAppDef[] = [
  {
    name: 'Brave Browser',
    bundleIds: ['com.brave.browser', 'com.brave.browser.beta', 'com.brave.browser.nightly'],
    darwinExecs: [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      join(homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
      '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
      '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly',
    ],
    linuxExecs: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'],
    winExecs: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  },
  {
    name: 'Google Chrome',
    bundleIds: [
      'com.google.chrome',
      'com.google.chrome.canary',
      'com.google.chrome.beta',
      'com.google.chrome.dev',
    ],
    darwinExecs: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    ],
    linuxExecs: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-unstable',
    ],
    winExecs: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  },
  {
    name: 'Microsoft Edge',
    bundleIds: [
      'com.microsoft.edgemac',
      'com.microsoft.edge',
      'com.microsoft.edgemac.canary',
      'com.microsoft.edgemac.dev',
      'com.microsoft.edgemac.beta',
    ],
    darwinExecs: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      join(homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
      '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
      '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
    ],
    linuxExecs: [
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/microsoft-edge-dev',
      '/usr/bin/microsoft-edge-beta',
    ],
    winExecs: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  },
  {
    name: 'Arc',
    bundleIds: ['company.thebrowser.browser'],
    darwinExecs: [
      '/Applications/Arc.app/Contents/MacOS/Arc',
      join(homedir(), 'Applications/Arc.app/Contents/MacOS/Arc'),
    ],
  },
  {
    name: 'Chromium',
    bundleIds: ['org.chromium.chromium'],
    darwinExecs: [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
    ],
    linuxExecs: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  },
  {
    name: 'Vivaldi',
    bundleIds: ['com.vivaldi.vivaldi'],
    darwinExecs: [
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
      join(homedir(), 'Applications/Vivaldi.app/Contents/MacOS/Vivaldi'),
    ],
    linuxExecs: ['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable'],
  },
  {
    name: 'Opera',
    bundleIds: ['com.operasoftware.opera', 'com.operasoftware.operagx'],
    darwinExecs: [
      '/Applications/Opera.app/Contents/MacOS/Opera',
      '/Applications/Opera GX.app/Contents/MacOS/Opera GX',
      join(homedir(), 'Applications/Opera.app/Contents/MacOS/Opera'),
    ],
    linuxExecs: ['/usr/bin/opera'],
  },
];

const NON_CHROMIUM_BROWSERS: Record<string, string> = {
  'com.apple.safari': 'Safari',
  'com.apple.safaritechnologypreview': 'Safari Technology Preview',
  'org.mozilla.firefox': 'Firefox',
  'org.mozilla.nightly': 'Firefox Nightly',
  'org.mozilla.firefoxdeveloperedition': 'Firefox Developer Edition',
  'org.torproject.torbrowser': 'Tor Browser',
};

function getMacDefaultBundleId(): string | null {
  try {
    const output = execSync(
      'defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null',
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const blocks = output.split('},');
    for (const block of blocks) {
      if (/LSHandlerURLScheme\s*=\s*https?;/i.test(block)) {
        const matches = [...block.matchAll(/LSHandlerRoleAll\s*=\s*"([^"-][^"]*)";/gi)];
        const lastMatch = matches[matches.length - 1];
        if (lastMatch?.[1]) {
          return lastMatch[1].toLowerCase();
        }
      }
    }
  } catch {
    // Ignore error
  }
  return null;
}

function resolveMacAppExecutable(bundleId: string): string | null {
  try {
    const raw = execSync(
      `osascript -e 'POSIX path of (path to application id "${bundleId}")' 2>/dev/null`,
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!raw || !existsSync(raw)) return null;

    const plistPath = join(raw, 'Contents', 'Info.plist');
    if (existsSync(plistPath)) {
      const content = readFileSync(plistPath, 'utf8');
      const match = content.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
      if (match && match[1]) {
        const execPath = join(raw, 'Contents', 'MacOS', match[1]);
        if (existsSync(execPath)) return execPath;
      }
    }
  } catch {
    // Ignore error
  }
  return null;
}

export interface DiscoveredBrowser {
  name: string;
  executablePath: string;
  isDefault: boolean;
  fallbackFrom?: string;
}

/**
 * Find the default or preferred Chromium executable on the user's system.
 */
export function findChromiumBrowser(): DiscoveredBrowser | null {
  // 1. Explicit override via env var
  const envPath = process.env.TRACEBACK_BROWSER_PATH || process.env.CHROME_PATH;
  if (envPath && existsSync(envPath)) {
    return {
      name: 'Custom Chromium',
      executablePath: envPath,
      isDefault: true,
    };
  }

  const platform = process.platform;

  // 2. Try to detect system default browser
  let defaultBundleId: string | null = null;
  let fallbackFrom: string | undefined = undefined;

  if (platform === 'darwin') {
    defaultBundleId = getMacDefaultBundleId();
    if (defaultBundleId && NON_CHROMIUM_BROWSERS[defaultBundleId]) {
      fallbackFrom = NON_CHROMIUM_BROWSERS[defaultBundleId];
    }
  }

  // If default browser is a recognized Chromium app, try to find its executable first
  if (defaultBundleId && !fallbackFrom) {
    for (const app of CHROMIUM_APPS) {
      if (app.bundleIds.includes(defaultBundleId)) {
        const candidatePaths = app.darwinExecs || [];
        for (const p of candidatePaths) {
          if (existsSync(p)) {
            return {
              name: app.name,
              executablePath: p,
              isDefault: true,
            };
          }
        }
        const dynamicPath = resolveMacAppExecutable(defaultBundleId);
        if (dynamicPath && existsSync(dynamicPath)) {
          return {
            name: app.name,
            executablePath: dynamicPath,
            isDefault: true,
          };
        }
      }
    }
  }

  // 3. Fallback: Search through installed Chromium apps in priority order
  for (const app of CHROMIUM_APPS) {
    let paths: string[] = [];
    if (platform === 'darwin') paths = app.darwinExecs;
    else if (platform === 'linux') paths = app.linuxExecs || [];
    else if (platform === 'win32') paths = app.winExecs || [];

    for (const p of paths) {
      if (existsSync(p)) {
        return {
          name: app.name,
          executablePath: p,
          isDefault: !fallbackFrom,
          fallbackFrom,
        };
      }
    }
  }

  return null;
}

function getMissingBrowserErrorMessage(): string {
  const installHint =
    process.platform === 'darwin'
      ? '\n  Please install one to continue (e.g. via Homebrew):\n' +
        '    brew install --cask brave-browser\n' +
        '    # or\n' +
        '    brew install --cask google-chrome\n' +
        '    # or\n' +
        '    brew install --cask microsoft-edge\n' +
        '    # or\n' +
        '    brew install --cask arc'
      : '\n  Please install Google Chrome, Brave, Microsoft Edge, or Chromium to continue.';

  return (
    'No Chromium-based browser found on your system.\n' +
    '  Local test execution requires a Chromium browser to connect via the Chrome DevTools Protocol (CDP).\n' +
    '  (Safari and Firefox do not support CDP).\n' +
    installHint
  );
}

/**
 * Fetch the CDP WebSocket URL from Chrome/Chromium's debug endpoint.
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
              reject(new Error('Invalid JSON from browser'));
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
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error(`Could not connect to browser on port ${port} after ${retries} attempts`);
}

export interface LaunchedChrome {
  /** The browser child process. */
  process: ChildProcess;
  /** The CDP WebSocket URL (e.g. ws://127.0.0.1:9222/devtools/browser/xxx). */
  cdpUrl: string;
  /** Friendly browser name (e.g. Brave Browser, Google Chrome). */
  browserName: string;
  /** Executable path launched. */
  executablePath: string;
  /** If the default was non-Chromium (e.g. Safari), the name of that default browser. */
  fallbackFrom?: string;
  /** Kill the browser process. */
  kill: () => void;
}

export interface LaunchChromeOptions {
  port?: number;
  headed?: boolean;
}

export async function launchChrome(
  optionsOrPort: LaunchChromeOptions | number = CDP_PORT,
): Promise<LaunchedChrome> {
  const port = typeof optionsOrPort === 'number' ? optionsOrPort : (optionsOrPort.port ?? CDP_PORT);

  const browser = findChromiumBrowser();
  if (!browser) {
    throw new Error(getMissingBrowserErrorMessage());
  }

  const tempProfile = join(tmpdir(), `traceback-browser-${Date.now()}`);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-fre',
    '--disable-features=BraveP3A,Translate',
    '--password-store=basic',
    '--use-mock-keychain',
    'about:blank',
    '--window-size=1920,1080',
    '--window-position=0,0',
  ];

  const browserProcess = spawn(browser.executablePath, args, {
    stdio: 'ignore',
    detached: false,
  });

  browserProcess.on('error', (err) => {
    throw new Error(`Failed to start ${browser.name}: ${err.message}`);
  });

  const cdpUrl = await getCdpUrl(port);

  return {
    process: browserProcess,
    cdpUrl,
    browserName: browser.name,
    executablePath: browser.executablePath,
    fallbackFrom: browser.fallbackFrom,
    kill: () => {
      try {
        browserProcess.kill();
      } catch {
        /* already dead */
      }
    },
  };
}
