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
