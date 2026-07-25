import type { CliContext, ServiceRegistry, InfraRegistry } from './types/context.js';
import { createLogger } from './infrastructure/logger/logger.factory.js';
import { createUIService } from './infrastructure/ui/formatting.js';
import { createConfigService } from './infrastructure/config/config.writer.js';
import { createFileStore } from './infrastructure/storage/file.store.js';
import { createApiClient } from './infrastructure/api/client.js';
import { createFileAuthStore } from './infrastructure/auth/auth.store.js';
import { createAuthService } from './infrastructure/auth/auth.refresher.js';
import {
  createTelemetryService,
  createNoopTelemetryService,
} from './infrastructure/telemetry/telemetry.service.js';
import { createUpdateChecker } from './infrastructure/update/update.checker.js';
import { createProjectService } from './services/project/project.service.js';
import { createAgentService } from './services/agent/agent.service.js';
import { createRunService } from './services/run/run.service.js';
import { createDoctorService } from './services/doctor/doctor.service.js';
import { resolveFlags } from './middleware/inject-context.js';
import { getConfigDir, getGlobalAuthPath, getLogsDir } from './platform/paths.js';
import type { ResolvedFlags } from './types/context.js';
import type { StoredToken } from './infrastructure/auth/auth.types.js';

export interface BootstrapOptions extends ResolvedFlags {}

export async function bootstrap(opts: BootstrapOptions): Promise<CliContext> {
  const flags = resolveFlags(opts);

  const configDir = getConfigDir();
  const authFilePath = getGlobalAuthPath();
  const logsDir = getLogsDir();

  const logLevel = flags.silent ? 'silent' : flags.debug ? 'debug' : 'info';

  const logger = createLogger({
    level: logLevel,
    pretty: !flags.json && !flags.ci && !flags.noColor,
    filePath: undefined,
  });

  logger.debug('Bootstrapping CLI');

  const fileStore = createFileStore();

  const ui = createUIService({
    json: flags.json,
    debug: flags.debug,
    silent: flags.silent,
    noColor: flags.noColor,
    interactive: !flags.ci && !flags.json,
  });

  const configService = createConfigService({ configDir, logger });
  const resolvedConfig = await configService.loadGlobalConfig();

  logger.debug(`API URL: ${resolvedConfig.apiUrl}`);

  const apiClient = createApiClient({
    baseUrl: resolvedConfig.apiUrl,
    timeout: 30_000,
    logger,
  });

  const authStore = createFileAuthStore(authFilePath, fileStore);

  const authService = createAuthService(apiClient, authStore, logger);

  const token = await authStore.get();
  if (token && isTokenValid(token)) {
    apiClient.setAuthToken(token.accessToken);
    const label = token.workspaceSlug || token.email || 'unknown';
    logger.debug(`Authenticated — workspace: ${label}`);
  }

  const telemetryEnabled = resolvedConfig.telemetryEnabled && !flags.ci;
  const telemetryService = telemetryEnabled
    ? createTelemetryService({ enabled: true, apiUrl: resolvedConfig.apiUrl }, logger)
    : createNoopTelemetryService();

  const updateChecker = createUpdateChecker(process.env.TRACEBACK_VERSION ?? '0.0.0', logger);

  const infra: InfraRegistry = {
    api: apiClient,
    auth: authService,
    authStore,
    config: configService,
    logger,
    telemetry: telemetryService,
    update: updateChecker,
    ui,
  };

  const services: ServiceRegistry = {
    project: createProjectService({ api: apiClient, logger }),
    agent: createAgentService({ api: apiClient, logger }),
    run: createRunService({ api: apiClient, logger }),
    doctor: createDoctorService({
      config: configService,
      auth: authService,
      api: apiClient,
      updateChecker,
      fileStore,
      logger,
      configDir,
      logsDir,
    }),
  };

  return { services, infra, flags };
}

function isTokenValid(token: StoredToken): boolean {
  // API keys have no expiry — the token is valid as long as it exists.
  // JWT-based tokens (legacy) check expiresAt.
  if (token.expiresAt == null) return true;
  return Date.now() < token.expiresAt - 60_000;
}
