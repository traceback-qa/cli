import { config as loadDotenv } from 'dotenv';
import type { GlobalConfig, ProjectConfig, ConfigSource, ResolvedConfig } from './config.types.js';
import { GlobalConfigSchema } from './config.schema.js';
import { DEFAULT_API_URL } from '../../constants/urls.js';
import { getEnvFlag, getEnvBoolFlag } from '../../platform/process.js';

// Load .env file so TRACEBACK_API_URL etc. are available in process.env
loadDotenv();

const DEFAULTS: GlobalConfig = {
  apiUrl: DEFAULT_API_URL,
  defaultEnvironment: 'production',
  telemetryEnabled: true,
  updateCheckEnabled: true,
};

export function createEnvSource(): ConfigSource {
  return {
    name: 'environment',
    priority: 90,
    load: async () => {
      const config: Partial<GlobalConfig> = {};
      const apiUrl = getEnvFlag('API_URL');
      if (apiUrl) config.apiUrl = apiUrl;
      const env = getEnvFlag('ENVIRONMENT');
      if (env) config.defaultEnvironment = env;
      const telemetryOff = getEnvBoolFlag('TELEMETRY_OFF');
      if (telemetryOff !== undefined) config.telemetryEnabled = !telemetryOff;
      return config;
    },
  };
}

export function createDefaultsSource(): ConfigSource {
  return {
    name: 'defaults',
    priority: 0,
    load: async () => DEFAULTS,
  };
}

export function createFileSource(configPath: string): ConfigSource {
  return {
    name: 'global-config',
    priority: 50,
    load: async () => {
      const { loadGlobalConfigFromFile } = await import('./config.loader.js');
      return loadGlobalConfigFromFile(configPath) ?? {};
    },
  };
}

export async function resolveConfig(
  sources: ConfigSource[],
  projectConfig?: ProjectConfig | null,
): Promise<ResolvedConfig> {
  const sorted = [...sources].sort((a, b) => a.priority - b.priority);

  let merged: Record<string, unknown> = {};
  for (const source of sorted) {
    const data = await source.load();
    merged = { ...merged, ...data };
  }

  const parsed = GlobalConfigSchema.parse(merged);

  return {
    ...parsed,
    project: projectConfig ?? undefined,
  };
}
