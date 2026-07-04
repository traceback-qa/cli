import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig, ProjectConfig } from './config.types.js';
import { GlobalConfigSchema, ProjectConfigSchema } from './config.schema.js';
import { PROJECT_CONFIG_FILES } from '../../constants/paths.js';

export function loadGlobalConfigFromFile(configPath: string): Partial<GlobalConfig> | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf-8');
    const data = JSON.parse(raw);
    const parsed = GlobalConfigSchema.partial().parse(data);
    return parsed as Partial<GlobalConfig>;
  } catch {
    return null;
  }
}

export function saveGlobalConfigFile(configPath: string, config: Partial<GlobalConfig>): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existing = loadGlobalConfigFromFile(configPath) ?? {};
  const merged = { ...existing, ...config };

  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
}

export function loadProjectConfigFromCwd(cwd: string): ProjectConfig | null {
  for (const fileName of PROJECT_CONFIG_FILES) {
    const filePath = path.join(cwd, fileName);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        const parsed = ProjectConfigSchema.parse(data);
        return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
}
