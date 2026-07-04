import type { Logger } from '../infrastructure/logger/logger.types.js';
import type { UIService } from '../infrastructure/ui/ui.types.js';
import type { ApiClient } from '../infrastructure/api/api.types.js';
import type { AuthService } from '../infrastructure/auth/auth.types.js';
import type { AuthStore } from '../infrastructure/auth/auth.types.js';
import type { ConfigService } from '../infrastructure/config/config.types.js';
import type { TelemetryService } from '../infrastructure/telemetry/telemetry.types.js';
import type { UpdateChecker } from '../infrastructure/update/update.types.js';
import type { ProjectService } from '../services/project/project.types.js';
import type { AgentService } from '../services/agent/agent.types.js';
import type { RunService } from '../services/run/run.types.js';
import type { DoctorService } from '../services/doctor/doctor.types.js';

export interface ServiceRegistry {
  project: ProjectService;
  agent: AgentService;
  run: RunService;
  doctor: DoctorService;
}

export interface InfraRegistry {
  api: ApiClient;
  auth: AuthService;
  authStore: AuthStore;
  config: ConfigService;
  logger: Logger;
  telemetry: TelemetryService;
  update: UpdateChecker;
  ui: UIService;
}

export interface ResolvedFlags {
  debug: boolean;
  silent: boolean;
  json: boolean;
  ci: boolean;
  noColor: boolean;
}

export interface CliContext {
  services: ServiceRegistry;
  infra: InfraRegistry;
  flags: ResolvedFlags;
}
