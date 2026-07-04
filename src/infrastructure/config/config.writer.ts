import type { ConfigService, ConfigServiceOptions, GlobalConfig, ProjectConfig, ResolvedConfig } from './config.types.js';
import { loadGlobalConfigFromFile, saveGlobalConfigFile, loadProjectConfigFromCwd } from './config.loader.js';
import { createEnvSource, createDefaultsSource, createFileSource, resolveConfig } from './config.resolver.js';

export function createConfigService(opts: ConfigServiceOptions): ConfigService {
  const { configDir, logger } = opts;
  const configPath = `${configDir}/config.json`;

  return {
    async loadGlobalConfig(): Promise<ResolvedConfig> {
      logger.debug(`Loading global config from: ${configPath}`);
      const sources = [
        createDefaultsSource(),
        createFileSource(configPath),
        createEnvSource(),
      ];
      return resolveConfig(sources);
    },

    async loadProjectConfig(cwd: string): Promise<ProjectConfig | null> {
      logger.debug(`Loading project config from: ${cwd}`);
      return loadProjectConfigFromCwd(cwd);
    },

    async resolveConfig(cwd?: string): Promise<ResolvedConfig> {
      const [globalConfig, projectConfig] = await Promise.all([
        this.loadGlobalConfig(),
        cwd ? this.loadProjectConfig(cwd) : null,
      ]);

      if (projectConfig) {
        return { ...globalConfig, project: projectConfig };
      }
      return globalConfig;
    },

    async setGlobalConfig(partial: Partial<GlobalConfig>): Promise<void> {
      logger.debug('Writing global config');
      saveGlobalConfigFile(configPath, partial);
    },

    getConfigDir(): string {
      return configDir;
    },
  };
}
