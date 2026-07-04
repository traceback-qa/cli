import type { Logger } from '../logger/logger.types.js';

export interface GlobalConfig {
  apiUrl: string;
  editor?: string;
  defaultOrg?: string;
  defaultEnvironment?: string;
  workspaceId?: string;
  telemetryEnabled: boolean;
  updateCheckEnabled: boolean;
  lastUpdateCheck?: number;
}

export interface ProjectConfig {
  projectId?: string;
  environment?: string;
  org?: string;
  custom?: Record<string, unknown>;
}

export interface ResolvedConfig extends GlobalConfig {
  project?: ProjectConfig;
}

export interface ConfigSource {
  name: string;
  priority: number;
  load: () => Promise<Partial<GlobalConfig & ProjectConfig>>;
}

export interface ConfigService {
  loadGlobalConfig: () => Promise<ResolvedConfig>;
  loadProjectConfig: (cwd: string) => Promise<ProjectConfig | null>;
  resolveConfig: (cwd?: string) => Promise<ResolvedConfig>;
  setGlobalConfig: (partial: Partial<GlobalConfig>) => Promise<void>;
  getConfigDir: () => string;
}

export interface ConfigServiceOptions {
  configDir: string;
  logger: Logger;
}
