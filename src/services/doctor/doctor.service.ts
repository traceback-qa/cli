import { execSync } from 'child_process';
import { xcodeAppInstalled } from '../../infrastructure/mobile/device.detector.js';
import type { DoctorService, DoctorServiceDeps, DoctorCheckResult } from './doctor.types.js';

export function createDoctorService(deps: DoctorServiceDeps): DoctorService {
  return {
    async runDiagnostics(): Promise<DoctorCheckResult[]> {
      const results: DoctorCheckResult[] = [];

      results.push(await checkConfigDir(deps));
      results.push(await checkAuth(deps));
      results.push(await checkApiConnectivity(deps));
      results.push(await checkUpdates(deps));
      results.push(await checkLogsDir(deps));
      results.push(await checkJava());
      results.push(await checkXcode());

      return results;
    },
  };
}

async function checkConfigDir(deps: DoctorServiceDeps): Promise<DoctorCheckResult> {
  try {
    if (deps.fileStore.exists(deps.configDir)) {
      return { name: 'Config directory', status: 'ok', message: `Found: ${deps.configDir}` };
    }
    return {
      name: 'Config directory',
      status: 'warning',
      message: `Not found: ${deps.configDir}`,
      suggestion: 'This will be created on first use.',
    };
  } catch {
    return {
      name: 'Config directory',
      status: 'error',
      message: 'Could not check config directory',
    };
  }
}

async function checkAuth(deps: DoctorServiceDeps): Promise<DoctorCheckResult> {
  try {
    const isAuth = await deps.auth.isAuthenticated();
    if (isAuth) {
      const account = await deps.auth.getCurrentAccount();
      return {
        name: 'Authentication',
        status: 'ok',
        message: account ? `Authenticated as ${account.email}` : 'Authenticated',
      };
    }
    return {
      name: 'Authentication',
      status: 'warning',
      message: 'Not authenticated',
      suggestion: 'Run `traceback auth login` to authenticate.',
    };
  } catch {
    return {
      name: 'Authentication',
      status: 'error',
      message: 'Could not check authentication status',
    };
  }
}

async function checkApiConnectivity(deps: DoctorServiceDeps): Promise<DoctorCheckResult> {
  try {
    await deps.api.get('/health');
    return { name: 'API connectivity', status: 'ok', message: 'API is reachable' };
  } catch {
    return {
      name: 'API connectivity',
      status: 'error',
      message: 'Could not reach API',
      suggestion: 'Check your internet connection and API URL.',
    };
  }
}

async function checkUpdates(deps: DoctorServiceDeps): Promise<DoctorCheckResult> {
  try {
    const result = await deps.updateChecker.check();
    if (result?.hasUpdate) {
      return {
        name: 'CLI version',
        status: 'warning',
        message: `Update available: ${result.current} → ${result.latest}`,
        suggestion: 'Run `traceback update install` to update.',
      };
    }
    return {
      name: 'CLI version',
      status: 'ok',
      message: `Up to date (${result?.current ?? 'unknown'})`,
    };
  } catch {
    return { name: 'CLI version', status: 'warning', message: 'Could not check for updates' };
  }
}

async function checkLogsDir(deps: DoctorServiceDeps): Promise<DoctorCheckResult> {
  try {
    if (deps.fileStore.exists(deps.logsDir)) {
      return { name: 'Logs directory', status: 'ok', message: `Found: ${deps.logsDir}` };
    }
    return {
      name: 'Logs directory',
      status: 'warning',
      message: `Not found: ${deps.logsDir}`,
      suggestion: 'This will be created when logs are written.',
    };
  } catch {
    return { name: 'Logs directory', status: 'error', message: 'Could not check logs directory' };
  }
}

/** Appium's own doctor treats a working JDK as required (not optional) for the uiautomator2
 * driver — `traceback setup` checks this too (see setup/index.ts's checkJava), but `doctor` is
 * the thing setup itself tells people to re-run, so it needs to catch a JDK that was removed or
 * never installed independently of a setup run. */
async function checkJava(): Promise<DoctorCheckResult> {
  try {
    const output = execSync('java -version 2>&1', { encoding: 'utf-8', timeout: 5000 }).trim();
    return { name: 'Java (JDK)', status: 'ok', message: output.split('\n')[0] || 'Found' };
  } catch {
    return {
      name: 'Java (JDK)',
      status: 'warning',
      message: 'Java not found',
      suggestion:
        'Needed by the Android (uiautomator2) driver. Run `traceback setup` for install instructions.',
    };
  }
}

/** macOS only. `xcrun`/`simctl` fails identically whether Xcode was never installed or is
 * installed but `xcode-select` still points at the bare Command Line Tools — those need
 * different fixes, so this distinguishes them the same way device.detector.ts's live-device
 * scan already does, rather than sending an already-has-Xcode user to `xcode-select --install`
 * (which doesn't change the selected path and would just send them in circles). */
async function checkXcode(): Promise<DoctorCheckResult> {
  if (process.platform !== 'darwin') {
    return {
      name: 'Xcode Command Line Tools',
      status: 'ok',
      message: 'Not applicable (non-macOS)',
    };
  }
  try {
    // Not `xcrun --version` — see setup/index.ts's checkXcode for why that's a false positive
    // when `xcode-select` points at the bare Command Line Tools instead of full Xcode.app.
    execSync('xcrun simctl list devices', { stdio: 'pipe', timeout: 5000 });
    return { name: 'Xcode Command Line Tools', status: 'ok', message: 'Found' };
  } catch {
    if (xcodeAppInstalled()) {
      return {
        name: 'Xcode Command Line Tools',
        status: 'warning',
        message: 'Xcode is installed, but `xcode-select` points at the bare Command Line Tools',
        suggestion: 'Fix it with: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      };
    }
    return {
      name: 'Xcode Command Line Tools',
      status: 'warning',
      message: 'Not found',
      suggestion: 'Needed to run tests on iOS simulators. Install with `xcode-select --install`.',
    };
  }
}
