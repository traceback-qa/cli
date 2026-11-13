/**
 * Package Manager & Dependency Installer Helper
 *
 * Discovers available system package managers (Homebrew, Winget, Chocolatey)
 * and provides commands to install missing platform dependencies (JDK, Android tools, ffmpeg, Appium).
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../../platform/paths.js';

export type SupportedPackageManager = 'brew' | 'winget' | 'choco';

export interface PackageManagerInfo {
  manager: SupportedPackageManager;
  binPath: string;
}

export interface InstallPlan {
  command: string;
  args: string[];
  description: string;
}

/**
 * Check if a command is runnable on the system PATH.
 */
export function commandExists(cmd: string): boolean {
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect available system package manager.
 */
export function detectPackageManager(): PackageManagerInfo | null {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    if (commandExists('brew')) {
      return { manager: 'brew', binPath: 'brew' };
    }
    // Also check standard macOS Homebrew paths if not on current PATH
    if (process.platform === 'darwin') {
      if (fs.existsSync('/opt/homebrew/bin/brew')) {
        return { manager: 'brew', binPath: '/opt/homebrew/bin/brew' };
      }
      if (fs.existsSync('/usr/local/bin/brew')) {
        return { manager: 'brew', binPath: '/usr/local/bin/brew' };
      }
    }
  } else if (process.platform === 'win32') {
    if (commandExists('winget')) {
      return { manager: 'winget', binPath: 'winget' };
    }
    if (commandExists('choco')) {
      return { manager: 'choco', binPath: 'choco' };
    }
  }
  return null;
}

/**
 * Get the install command for a specific dependency using the detected package manager.
 */
export function getPackageInstallPlan(
  pkg: 'java' | 'android-sdk' | 'ffmpeg',
  pm?: PackageManagerInfo | null,
): InstallPlan | null {
  const currentPm = pm !== undefined ? pm : detectPackageManager();
  if (!currentPm) return null;

  switch (currentPm.manager) {
    case 'brew': {
      if (pkg === 'java') {
        return {
          command: currentPm.binPath,
          args: ['install', 'openjdk@17'],
          description: 'Install OpenJDK 17 via Homebrew',
        };
      }
      if (pkg === 'android-sdk') {
        return {
          command: currentPm.binPath,
          args: ['install', '--cask', 'android-platform-tools'],
          description: 'Install Android platform-tools (adb) via Homebrew Cask',
        };
      }
      if (pkg === 'ffmpeg') {
        return {
          command: currentPm.binPath,
          args: ['install', 'ffmpeg'],
          description: 'Install ffmpeg via Homebrew',
        };
      }
      break;
    }
    case 'winget': {
      if (pkg === 'java') {
        return {
          command: currentPm.binPath,
          args: [
            'install',
            'Microsoft.OpenJDK.17',
            '--accept-package-agreements',
            '--accept-source-agreements',
          ],
          description: 'Install Microsoft OpenJDK 17 via Winget',
        };
      }
      if (pkg === 'android-sdk') {
        return {
          command: currentPm.binPath,
          args: [
            'install',
            'Google.PlatformTools',
            '--accept-package-agreements',
            '--accept-source-agreements',
          ],
          description: 'Install Android Platform Tools via Winget',
        };
      }
      if (pkg === 'ffmpeg') {
        return {
          command: currentPm.binPath,
          args: [
            'install',
            'Gyan.FFmpeg',
            '--accept-package-agreements',
            '--accept-source-agreements',
          ],
          description: 'Install ffmpeg via Winget',
        };
      }
      break;
    }
    case 'choco': {
      if (pkg === 'java') {
        return {
          command: currentPm.binPath,
          args: ['install', 'openjdk17', '-y'],
          description: 'Install OpenJDK 17 via Chocolatey',
        };
      }
      if (pkg === 'android-sdk') {
        return {
          command: currentPm.binPath,
          args: ['install', 'adb', '-y'],
          description: 'Install Android adb via Chocolatey',
        };
      }
      if (pkg === 'ffmpeg') {
        return {
          command: currentPm.binPath,
          args: ['install', 'ffmpeg', '-y'],
          description: 'Install ffmpeg via Chocolatey',
        };
      }
      break;
    }
  }

  return null;
}

/**
 * Get isolated npm and bin directories in user space.
 */
export function getIsolatedNpmDirs(): {
  dataDir: string;
  binDir: string;
  npmPrefix: string;
  npmBinDir: string;
  npmModulesBinDir: string;
} {
  const dataDir = getDataDir();
  const binDir = path.join(dataDir, 'bin');
  const npmPrefix = path.join(dataDir, 'npm');
  const isWin = process.platform === 'win32';
  const npmBinDir = isWin ? npmPrefix : path.join(npmPrefix, 'bin');
  const npmModulesBinDir = path.join(npmPrefix, 'node_modules', '.bin');

  return {
    dataDir,
    binDir,
    npmPrefix,
    npmBinDir,
    npmModulesBinDir,
  };
}

/**
 * Execute an install plan asynchronously streaming stdout/stderr or buffering.
 */
export async function executeInstallPlan(
  plan: InstallPlan,
  onOutput?: (chunk: string) => void,
): Promise<{ success: boolean; exitCode: number }> {
  return await new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, {
      stdio: onOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env },
    });

    if (onOutput) {
      child.stdout?.on('data', (d: Buffer) => onOutput(d.toString('utf-8')));
      child.stderr?.on('data', (d: Buffer) => onOutput(d.toString('utf-8')));
    }

    child.on('error', () => resolve({ success: false, exitCode: 1 }));
    child.on('close', (code) => resolve({ success: code === 0, exitCode: code ?? 1 }));
  });
}
