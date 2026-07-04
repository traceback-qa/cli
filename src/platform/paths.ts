import os from 'node:os';
import path from 'node:path';

import { APP_NAME, CONFIG_FILE_NAME, AUTH_FILE_NAME, TELEMETRY_FILE_NAME, LOGS_DIR_NAME } from '../constants/paths.js';

function getConfigHome(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), APP_NAME);
  }
}

function getDataHome(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), APP_NAME);
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), APP_NAME);
  }
}

function getCacheHome(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Caches', APP_NAME);
    case 'win32':
      return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), APP_NAME, 'Cache');
    default:
      return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), APP_NAME);
  }
}

function resolveGlobalConfigDir(): string {
  const fromEnv = process.env.TRACEBACK_CONFIG_DIR;
  if (fromEnv) return fromEnv;
  return getConfigHome();
}

export function getGlobalConfigPath(): string {
  return path.join(resolveGlobalConfigDir(), CONFIG_FILE_NAME);
}

export function getGlobalAuthPath(): string {
  return path.join(resolveGlobalConfigDir(), AUTH_FILE_NAME);
}

export function getTelemetryPath(): string {
  return path.join(resolveGlobalConfigDir(), TELEMETRY_FILE_NAME);
}

export function getLogsDir(): string {
  const fromEnv = process.env.TRACEBACK_LOG_DIR;
  if (fromEnv) return fromEnv;
  return path.join(getDataHome(), LOGS_DIR_NAME);
}

export function getConfigDir(): string {
  return resolveGlobalConfigDir();
}

export function getDataDir(): string {
  return getDataHome();
}

export function getCacheDir(): string {
  return getCacheHome();
}

export function ensureDir(dirPath: string): void {
  const fs = requireNodeFs();
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function requireNodeFs() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs');
}
