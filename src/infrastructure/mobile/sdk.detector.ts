/**
 * SDK Detector & Environment Enricher
 *
 * Automatically locates Android SDK and Java JDK installations across platforms
 * (including bundled runtimes like Android Studio's JBR), enriches `process.env`
 * in-memory for spawned tools (Appium, adb, etc.), and manages shell profile exports.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDataDir } from '../../platform/paths.js';

export interface AndroidSdkInfo {
  sdkPath: string;
  adbPath: string;
  isCustom: boolean;
  onPath: boolean;
}

export interface JavaJdkInfo {
  javaHome: string;
  javaBin: string;
  version?: string;
  onPath: boolean;
}

/**
 * Returns list of plausible Android SDK installation directories for the current OS.
 */
export function defaultAndroidHomeCandidates(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [
        path.join(home, 'Library', 'Android', 'sdk'),
        path.join(home, 'Library', 'Android', 'Sdk'),
      ];
    case 'win32':
      return [
        process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
          : path.join(home, 'AppData', 'Local', 'Android', 'Sdk'),
        path.join(home, 'AppData', 'Local', 'Android', 'sdk'),
      ];
    default:
      return [
        path.join(home, 'Android', 'Sdk'),
        path.join(home, 'Android', 'sdk'),
        path.join(home, 'android-sdk'),
        '/usr/lib/android-sdk',
        '/opt/android-sdk',
      ];
  }
}

/**
 * Finds a valid Android SDK directory containing `platform-tools/adb`.
 */
export function findAndroidSdk(): AndroidSdkInfo | null {
  const adbBin = process.platform === 'win32' ? 'adb.exe' : 'adb';

  // 1. Check if adb is already runnable on PATH
  let onPath = false;
  try {
    execSync(`${adbBin} version`, { stdio: 'pipe', timeout: 3000 });
    onPath = true;
  } catch {
    onPath = false;
  }

  // 2. Check explicit env variables first
  const envSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (envSdk && fs.existsSync(envSdk)) {
    const adbPath = path.join(envSdk, 'platform-tools', adbBin);
    if (fs.existsSync(adbPath)) {
      return {
        sdkPath: envSdk,
        adbPath,
        isCustom: true,
        onPath,
      };
    }
  }

  // 3. Check well-known candidate paths
  for (const candidate of defaultAndroidHomeCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const adbPath = path.join(candidate, 'platform-tools', adbBin);
    if (fs.existsSync(adbPath)) {
      return {
        sdkPath: candidate,
        adbPath,
        isCustom: false,
        onPath,
      };
    }
  }

  return null;
}

/**
 * Returns candidate JAVA_HOME directories to search if not configured on PATH.
 */
function defaultJavaHomeCandidates(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === 'darwin') {
    // Android Studio bundled JBR (JetBrains Runtime)
    candidates.push(
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
      '/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home',
      '/Applications/Android Studio.app/Contents/jre/Contents/Home',
    );

    // Homebrew OpenJDKs
    candidates.push(
      '/opt/homebrew/opt/openjdk@17',
      '/opt/homebrew/opt/openjdk@21',
      '/opt/homebrew/opt/openjdk',
      '/usr/local/opt/openjdk@17',
      '/usr/local/opt/openjdk@21',
      '/usr/local/opt/openjdk',
    );

    // macOS java_home utility
    try {
      const jh = execSync('/usr/libexec/java_home 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (jh && fs.existsSync(jh)) candidates.push(jh);
    } catch {
      // ignore
    }

    // System JavaVirtualMachines folder
    const jvmDir = '/Library/Java/JavaVirtualMachines';
    if (fs.existsSync(jvmDir)) {
      try {
        const entries = fs.readdirSync(jvmDir);
        for (const entry of entries) {
          const homePath = path.join(jvmDir, entry, 'Contents', 'Home');
          if (fs.existsSync(homePath)) candidates.push(homePath);
        }
      } catch {
        // ignore
      }
    }
  } else if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Android\\Android Studio\\jbr',
      'C:\\Program Files\\Android\\Android Studio\\jre',
      'C:\\Program Files\\Eclipse Adoptium\\jdk-17',
      'C:\\Program Files\\Microsoft\\jdk-17',
    );
  } else {
    // Linux
    candidates.push(
      '/usr/lib/jvm/default-java',
      '/usr/lib/jvm/java-17-openjdk-amd64',
      '/usr/lib/jvm/java-17-openjdk-arm64',
      '/usr/lib/jvm/java-21-openjdk-amd64',
      '/usr/lib/jvm/java-11-openjdk-amd64',
    );
  }

  // Version managers (SDKMAN, asdf)
  const sdkmanCurrent = path.join(home, '.sdkman', 'candidates', 'java', 'current');
  if (fs.existsSync(sdkmanCurrent)) candidates.push(sdkmanCurrent);

  return candidates;
}

/**
 * Finds a valid Java JDK installation and returns its JAVA_HOME.
 */
export function findJavaJdk(): JavaJdkInfo | null {
  const javaBin = process.platform === 'win32' ? 'java.exe' : 'java';

  // 1. Check if java is already working on PATH
  let onPath = false;
  let pathVersion: string | undefined;
  try {
    const out = execSync(`${javaBin} -version 2>&1`, { encoding: 'utf-8', timeout: 3000 }).trim();
    onPath = true;
    pathVersion = out.split('\n')[0];
  } catch {
    onPath = false;
  }

  // 2. Check explicit JAVA_HOME
  const envJavaHome = process.env.JAVA_HOME;
  if (envJavaHome && fs.existsSync(envJavaHome)) {
    const binPath = path.join(envJavaHome, 'bin', javaBin);
    if (fs.existsSync(binPath)) {
      try {
        const out = execSync(`"${binPath}" -version 2>&1`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
        return {
          javaHome: envJavaHome,
          javaBin: binPath,
          version: out.split('\n')[0] || pathVersion,
          onPath,
        };
      } catch {
        // continue
      }
    }
  }

  // 3. Check candidate paths
  for (const candidate of defaultJavaHomeCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const binPath = path.join(candidate, 'bin', javaBin);
    if (fs.existsSync(binPath)) {
      try {
        const out = execSync(`"${binPath}" -version 2>&1`, {
          encoding: 'utf-8',
          timeout: 3000,
        }).trim();
        return {
          javaHome: candidate,
          javaBin: binPath,
          version: out.split('\n')[0] || 'Found',
          onPath,
        };
      } catch {
        // continue
      }
    }
  }

  if (onPath) {
    return {
      javaHome: '',
      javaBin,
      version: pathVersion || 'Found on PATH',
      onPath: true,
    };
  }

  return null;
}

/**
 * Injects detected Android SDK and Java JDK paths into `process.env` in-memory.
 * Ensures spawned processes (Appium, adb, uiautomator2) inherit necessary variables.
 */
export function enrichMobileEnv(): {
  androidHomeSet: boolean;
  javaHomeSet: boolean;
  pathUpdated: boolean;
} {
  let androidHomeSet = false;
  let javaHomeSet = false;
  let pathUpdated = false;

  const currentPath = process.env.PATH || '';
  const pathParts = currentPath.split(path.delimiter);

  // 1. Traceback CLI isolated bin and npm tool directories
  const dataDir = getDataDir();
  const binDir = path.join(dataDir, 'bin');
  const npmPrefix = path.join(dataDir, 'npm');
  const npmBinDir = process.platform === 'win32' ? npmPrefix : path.join(npmPrefix, 'bin');
  const npmModulesBinDir = path.join(npmPrefix, 'node_modules', '.bin');

  for (const dir of [binDir, npmBinDir, npmModulesBinDir]) {
    if (fs.existsSync(dir) && !pathParts.includes(dir)) {
      pathParts.unshift(dir);
      pathUpdated = true;
    }
  }

  // 2. Homebrew standard bin directories on macOS
  if (process.platform === 'darwin') {
    for (const brewDir of ['/opt/homebrew/bin', '/usr/local/bin']) {
      if (fs.existsSync(brewDir) && !pathParts.includes(brewDir)) {
        pathParts.unshift(brewDir);
        pathUpdated = true;
      }
    }
  }

  // 3. Android SDK
  const sdk = findAndroidSdk();
  if (sdk) {
    if (!process.env.ANDROID_HOME) {
      process.env.ANDROID_HOME = sdk.sdkPath;
      androidHomeSet = true;
    }
    if (!process.env.ANDROID_SDK_ROOT) {
      process.env.ANDROID_SDK_ROOT = sdk.sdkPath;
    }

    const platformTools = path.join(sdk.sdkPath, 'platform-tools');
    const emulatorDir = path.join(sdk.sdkPath, 'emulator');

    if (!pathParts.includes(platformTools) && fs.existsSync(platformTools)) {
      pathParts.unshift(platformTools);
      pathUpdated = true;
    }
    if (!pathParts.includes(emulatorDir) && fs.existsSync(emulatorDir)) {
      pathParts.unshift(emulatorDir);
      pathUpdated = true;
    }
  }

  // 4. Java JDK
  const java = findJavaJdk();
  if (java && java.javaHome) {
    if (!process.env.JAVA_HOME) {
      process.env.JAVA_HOME = java.javaHome;
      javaHomeSet = true;
    }
    const javaBinDir = path.join(java.javaHome, 'bin');
    if (!pathParts.includes(javaBinDir) && fs.existsSync(javaBinDir)) {
      pathParts.unshift(javaBinDir);
      pathUpdated = true;
    }
  }

  if (pathUpdated) {
    process.env.PATH = pathParts.join(path.delimiter);
  }

  return { androidHomeSet, javaHomeSet, pathUpdated };
}

/**
 * Determines the preferred user shell profile path.
 */
export function getPreferredShellProfile(): string {
  const home = os.homedir();
  const shell = process.env.SHELL || '';

  if (shell.endsWith('zsh') || (!shell && process.platform === 'darwin')) {
    return path.join(home, '.zshrc');
  }
  if (shell.endsWith('bash')) {
    const bashProfile = path.join(home, '.bash_profile');
    if (fs.existsSync(bashProfile)) return bashProfile;
    return path.join(home, '.bashrc');
  }
  if (shell.endsWith('fish')) {
    return path.join(home, '.config', 'fish', 'config.fish');
  }

  return path.join(home, '.profile');
}

/**
 * Checks if the shell profile already contains exports for ANDROID_HOME or JAVA_HOME.
 */
export function checkProfileHasEnv(profilePath: string): {
  hasAndroid: boolean;
  hasJava: boolean;
  hasTracebackBin: boolean;
} {
  if (!fs.existsSync(profilePath)) {
    return { hasAndroid: false, hasJava: false, hasTracebackBin: false };
  }
  try {
    const content = fs.readFileSync(profilePath, 'utf-8');
    const binDir = path.join(getDataDir(), 'bin');
    return {
      hasAndroid: content.includes('ANDROID_HOME') || content.includes('ANDROID_SDK_ROOT'),
      hasJava: content.includes('JAVA_HOME'),
      hasTracebackBin: content.includes(binDir) || content.includes('.traceback/bin'),
    };
  } catch {
    return { hasAndroid: false, hasJava: false, hasTracebackBin: false };
  }
}

/**
 * Appends Android, Java, and Traceback bin exports to the user's shell profile.
 */
export function writeMobileEnvToShellProfile(
  profilePath: string,
  sdkPath?: string,
  javaHome?: string,
  includeTracebackBin = true,
): boolean {
  try {
    const lines: string[] = [];
    const status = checkProfileHasEnv(profilePath);
    const binDir = path.join(getDataDir(), 'bin');

    lines.push('\n# Traceback Mobile Environment');
    if (includeTracebackBin && !status.hasTracebackBin && fs.existsSync(binDir)) {
      lines.push(`export PATH="${binDir}:$PATH"`);
    }
    if (sdkPath && !status.hasAndroid) {
      lines.push(`export ANDROID_HOME="${sdkPath}"`);
      lines.push(`export ANDROID_SDK_ROOT="${sdkPath}"`);
      lines.push('export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"');
    }
    if (javaHome && !status.hasJava) {
      lines.push(`export JAVA_HOME="${javaHome}"`);
      lines.push('export PATH="$JAVA_HOME/bin:$PATH"');
    }

    if (lines.length > 1) {
      fs.mkdirSync(path.dirname(profilePath), { recursive: true });
      fs.appendFileSync(profilePath, lines.join('\n') + '\n', 'utf-8');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
