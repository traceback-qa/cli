import type { UpdateChecker, UpdateResult } from './update.types.js';
import type { Logger } from '../logger/logger.types.js';
import type { ApiClient } from '../api/api.types.js';
import { NPM_REGISTRY_URL } from '../../constants/urls.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function createUpdateChecker(currentVersion: string, logger: Logger): UpdateChecker {
  let lastCheckTime = 0;

  return {
    shouldCheck(): boolean {
      return Date.now() - lastCheckTime > CHECK_INTERVAL_MS;
    },

    async check(): Promise<UpdateResult | null> {
      lastCheckTime = Date.now();

      try {
        logger.debug(`Checking for updates. Current version: ${currentVersion}`);
        const response = await fetch(`${NPM_REGISTRY_URL}/latest`, {
          signal: AbortSignal.timeout(3000),
        });

        if (!response.ok) {
          logger.debug(`Update check failed with status: ${response.status}`);
          return null;
        }

        const data = (await response.json()) as { version: string };
        const latestVersion = data.version;

        if (!latestVersion) return null;

        const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
        const updateType = hasUpdate ? getUpdateType(latestVersion, currentVersion) : null;

        const result: UpdateResult = {
          current: currentVersion,
          latest: latestVersion,
          hasUpdate,
          type: updateType,
        };

        logger.debug(
          hasUpdate
            ? `Update available: ${currentVersion} → ${latestVersion} (${updateType})`
            : `Already up to date: ${currentVersion}`,
        );

        return result;
      } catch (error) {
        logger.debug(`Update check error: ${String(error)}`);
        return null;
      }
    },
  };
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function getUpdateType(latest: string, current: string): UpdateResult['type'] {
  const [latestMajor, latestMinor] = latest.split('.').map(Number) as [number, number, number];
  const [currentMajor, currentMinor] = current.split('.').map(Number) as [number, number, number];

  if (latestMajor > currentMajor) return 'major';
  if (latestMinor > currentMinor) return 'minor';
  return 'patch';
}
