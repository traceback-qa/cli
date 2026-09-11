/**
 * Appium Server Manager — manages the local Appium server lifecycle.
 *
 * Automatically checks if an Appium server is already running. If not, it spawns
 * a managed local Appium server child process, waits for the readiness probe to pass,
 * and cleanly stops it upon test completion or cancellation.
 */

import http from 'node:http';
import { spawn, execSync, type ChildProcess } from 'node:child_process';

export const DEFAULT_APPIUM_URL = 'http://localhost:4723';
export const DEFAULT_STARTUP_TIMEOUT_MS = 25_000;

export interface AppiumServerHandle {
  url: string;
  startedByUs: boolean;
  stop: () => Promise<void>;
}

export interface EnsureAppiumServerOptions {
  /** Target Appium server URL (default: http://localhost:4723) */
  appiumUrl?: string;
  /** Optional callback for status messages during startup */
  onStatus?: (message: string) => void;
  /** Timeout in ms to wait for the server to become ready (default: 25000) */
  startupTimeoutMs?: number;
}

/** Check if a command is executable on the current system PATH. */
export function commandExists(cmd: string): boolean {
  try {
    execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe an Appium server URL to see if it is running and accepting connections.
 */
export async function isAppiumRunning(url: string, timeoutMs = 1500): Promise<boolean> {
  const normalized = url.replace(/\/+$/, '');
  const statusUrl = `${normalized}/status`;

  return await new Promise<boolean>((resolve) => {
    try {
      const parsed = new URL(statusUrl);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 4723,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeout: timeoutMs,
        },
        (res) => {
          // Status endpoint responds with 200 when ready
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve(true);
          } else {
            resolve(false);
          }
          res.resume(); // drain response
        },
      );

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.on('error', () => {
        resolve(false);
      });

      req.end();
    } catch {
      resolve(false);
    }
  });
}

/**
 * Ensure an Appium server is running at the requested URL.
 *
 * If a server is already listening, it is reused and will NOT be terminated on stop().
 * If no server is running, launches `appium` locally as a managed background process,
 * waits for `/status` to respond, and returns a handle whose `stop()` method gracefully
 * shuts down the spawned server.
 */
export async function ensureAppiumServer(
  opts?: EnsureAppiumServerOptions,
): Promise<AppiumServerHandle> {
  const targetUrl = opts?.appiumUrl || DEFAULT_APPIUM_URL;
  const timeoutMs = opts?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  // 1. If Appium is already running, reuse it
  const alreadyRunning = await isAppiumRunning(targetUrl, 1500);
  if (alreadyRunning) {
    return {
      url: targetUrl,
      startedByUs: false,
      stop: async () => {
        // No-op: do not kill servers started by the user
      },
    };
  }

  // 2. Parse host & port
  let port = 4723;
  try {
    const parsed = new URL(targetUrl);
    if (parsed.port) {
      port = parseInt(parsed.port, 10);
    }
  } catch {
    // Fall back to default port
  }

  // 3. Verify Appium binary is installed
  if (!commandExists('appium')) {
    throw new Error(
      "Appium server is not running and the 'appium' command was not found.\\n" +
        'Run `traceback setup` to install Appium and its mobile drivers.',
    );
  }

  opts?.onStatus?.(`Starting local Appium server on port ${port}...`);

  // 4. Spawn Appium child process
  let stderrBuffer = '';
  let stdoutBuffer = '';

  const child: ChildProcess = spawn(
    'appium',
    ['--port', String(port), '--log-level', 'warn', '--relaxed-security'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    },
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8');
    if (stdoutBuffer.length > 8192) {
      stdoutBuffer = stdoutBuffer.slice(-8192);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString('utf-8');
    if (stderrBuffer.length > 8192) {
      stderrBuffer = stderrBuffer.slice(-8192);
    }
  });

  let exitedPrematurely = false;
  let exitCode: number | null = null;

  child.on('exit', (code) => {
    exitedPrematurely = true;
    exitCode = code;
  });

  // Register process exit listeners so abrupt CLI termination doesn't orphan the server
  const emergencyCleanup = () => {
    try {
      if (!child.killed && child.pid) {
        process.kill(child.pid, 'SIGKILL');
      }
    } catch {
      // Ignore errors during emergency cleanup
    }
  };

  process.once('exit', emergencyCleanup);
  process.once('SIGINT', emergencyCleanup);
  process.once('SIGTERM', emergencyCleanup);

  // 5. Poll until `/status` returns ready or timeout
  const startTime = Date.now();
  let isReady = false;

  while (Date.now() - startTime < timeoutMs) {
    if (exitedPrematurely) {
      process.removeListener('exit', emergencyCleanup);
      process.removeListener('SIGINT', emergencyCleanup);
      process.removeListener('SIGTERM', emergencyCleanup);
      const detail = (stderrBuffer || stdoutBuffer).trim();
      throw new Error(
        `Appium server process exited immediately (code ${exitCode}).` +
          (detail ? `\\nOutput: ${detail}` : ''),
      );
    }

    isReady = await isAppiumRunning(targetUrl, 800);
    if (isReady) {
      break;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  if (!isReady) {
    emergencyCleanup();
    process.removeListener('exit', emergencyCleanup);
    process.removeListener('SIGINT', emergencyCleanup);
    process.removeListener('SIGTERM', emergencyCleanup);
    const detail = (stderrBuffer || stdoutBuffer).trim();
    throw new Error(
      `Appium server failed to start within ${Math.round(timeoutMs / 1000)}s.` +
        (detail ? `\\nOutput: ${detail}` : ''),
    );
  }

  let stopped = false;

  return {
    url: targetUrl,
    startedByUs: true,
    stop: async () => {
      if (stopped) return;
      stopped = true;

      process.removeListener('exit', emergencyCleanup);
      process.removeListener('SIGINT', emergencyCleanup);
      process.removeListener('SIGTERM', emergencyCleanup);

      if (!child.killed) {
        try {
          child.kill('SIGINT');
        } catch {
          // Process already terminated
        }

        // Wait up to 3 seconds for graceful shutdown, then SIGKILL if needed
        await new Promise<void>((resolve) => {
          const killTimer = setTimeout(() => {
            try {
              if (!child.killed) {
                child.kill('SIGKILL');
              }
            } catch {
              // Ignore
            }
            resolve();
          }, 3000);

          child.once('exit', () => {
            clearTimeout(killTimer);
            resolve();
          });
        });
      }
    },
  };
}
