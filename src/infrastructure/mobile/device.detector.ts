/**
 * Device Detector — finds running Android emulators and iOS simulators.
 *
 * Uses platform-native tools:
 *   - Android: `adb devices` to list connected emulators/devices
 *   - iOS: `xcrun simctl list devices booted` to list running simulators
 *
 * Returns a unified list of devices the user can pick from, plus diagnostics that distinguish
 * "the tool itself couldn't be found/run" from "the tool ran fine, nothing's just booted" — a
 * PATH gap after a fresh `traceback setup`/Android Studio install (very common: installing the
 * SDK doesn't retroactively update an already-open terminal's PATH, since a child process can
 * never mutate its parent shell's environment) used to look identical to "no emulator running",
 * which sent people to start an emulator that was already running.
 */

import { execSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defaultAndroidHomeCandidates, findAndroidSdk, enrichMobileEnv } from './sdk.detector.js';

export interface MobileDevice {
  /** Unique device identifier (serial for Android, UDID for iOS). */
  id: string;
  /** Human-readable name (e.g. "Pixel 7 API 34", "iPhone 15 Pro"). */
  name: string;
  /** Platform: "android" or "ios". */
  platform: 'android' | 'ios';
  /** Device state (e.g. "device", "Booted"). */
  state: string;
}

export interface DeviceDetectionDiagnostics {
  /** false only when `adb` genuinely couldn't be located/run anywhere we checked — distinct
   *  from "ran fine, zero devices attached". */
  androidToolFound: boolean;
  /** Same, for `xcrun`. Always true on non-macOS (iOS testing doesn't apply there). */
  iosToolFound: boolean;
  /** True when Xcode.app is installed but `xcode-select` still points at the bare Command Line
   *  Tools — the one broken-but-easily-fixable iOS case worth calling out by name, since
   *  `xcrun simctl` fails with an unhelpful "unable to find utility" error in that state even
   *  with a real simulator already booted. */
  iosNeedsXcodeSelect: boolean;
}

export interface DeviceDetectionResult {
  devices: MobileDevice[];
  diagnostics: DeviceDetectionDiagnostics;
}

/** Resolves a real, runnable `adb` — bare `adb` on PATH first (the common case once a shell has
 * actually picked up the SDK's PATH entry), then `$ANDROID_HOME`/`$ANDROID_SDK_ROOT`, then the
 * well-known per-OS default install path. Returns null only if none of those actually run. */
function resolveAdb(): string | null {
  const sdk = findAndroidSdk();
  if (sdk?.adbPath) {
    try {
      execSync(`"${sdk.adbPath}" version`, { stdio: 'pipe', timeout: 5000 });
      return sdk.adbPath;
    } catch {
      // Continue to fallback candidates
    }
  }

  const adbBin = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    adbBin,
    ...[process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
      .filter((v): v is string => Boolean(v))
      .map((home) => path.join(home, 'platform-tools', adbBin)),
    ...defaultAndroidHomeCandidates().map((home) => path.join(home, 'platform-tools', adbBin)),
  ];

  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" version`, { stdio: 'pipe', timeout: 5000 });
      return candidate;
    } catch {
      // Not this one — try the next candidate.
    }
  }
  return null;
}

/**
 * Detect running Android emulators and connected devices via `adb devices`.
 *
 * Output format of `adb devices`:
 *   List of devices attached
 *   emulator-5554	device
 *   R5CT1234567	device
 */
function detectAndroidDevices(): { devices: MobileDevice[]; toolFound: boolean } {
  const adb = resolveAdb();
  if (!adb) return { devices: [], toolFound: false };

  try {
    const output = execSync(`"${adb}" devices -l`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const devices: MobileDevice[] = [];

    for (const line of output.split('\n').slice(1)) {
      if (!line.includes('device') || line.includes('offline')) continue;

      const parts = line.trim().split(/\s+/);
      const id = parts[0];
      if (!id) continue;

      // Extract model name from the -l output (e.g. model:Pixel_7)
      const modelMatch = line.match(/model:(\S+)/);
      const modelName = modelMatch?.[1];
      let name: string;
      if (modelName) {
        const formatted = modelName.replace(/_/g, ' ');
        if (id.startsWith('emulator')) {
          name =
            formatted.toLowerCase().includes('emulator') ||
            formatted.toLowerCase().includes('pixel') ||
            formatted.toLowerCase().includes('android')
              ? formatted
              : `Android Emulator (${formatted})`;
        } else {
          name = formatted;
        }
      } else {
        name = id.startsWith('emulator') ? `Android Emulator (${id})` : `Android Device (${id})`;
      }

      devices.push({
        id,
        name,
        platform: 'android' as const,
        state: 'device',
      });
    }

    return { devices, toolFound: true };
  } catch {
    // adb resolved but this particular invocation failed (e.g. server hiccup) — still a real,
    // found tool, just no devices to report.
    return { devices: [], toolFound: true };
  }
}

/** True when Xcode.app is installed under the usual /Applications location — used only to tell
 * "Xcode isn't installed" apart from "Xcode is installed but xcode-select points elsewhere". */
export function xcodeAppInstalled(): boolean {
  try {
    return fs.existsSync('/Applications/Xcode.app');
  } catch {
    return false;
  }
}

/**
 * Detect running iOS simulators via `xcrun simctl list devices booted`.
 *
 * Output format:
 *   == Devices ==
 *   -- iOS 17.5 --
 *       iPhone 15 Pro (ABCD-1234-...) (Booted)
 */
function getXcodeDeveloperDir(): string | undefined {
  if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR;
  if (fs.existsSync('/Applications/Xcode.app/Contents/Developer')) {
    return '/Applications/Xcode.app/Contents/Developer';
  }
  return undefined;
}

function detectIOSSimulators(): {
  devices: MobileDevice[];
  toolFound: boolean;
  needsXcodeSelect: boolean;
} {
  // Only available on macOS
  if (process.platform !== 'darwin')
    return { devices: [], toolFound: true, needsXcodeSelect: false };

  try {
    const devDir = getXcodeDeveloperDir();
    const env = devDir ? { ...process.env, DEVELOPER_DIR: devDir } : process.env;
    const output = execSync('xcrun simctl list devices booted', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
    });

    const devices: MobileDevice[] = [];

    for (const line of output.split('\n')) {
      // Match lines like: "    iPhone 15 Pro (ABCD-1234-...) (Booted)"
      const match = line.match(/^\s+(.+?)\s+\(([A-F0-9-]+)\)\s+\(Booted\)/i);
      const name = match?.[1];
      const id = match?.[2];
      if (name && id) {
        devices.push({
          id,
          name,
          platform: 'ios',
          state: 'Booted',
        });
      }
    }

    return { devices, toolFound: true, needsXcodeSelect: false };
  } catch {
    // `xcrun`/`simctl` couldn't run at all — the common cause is Xcode.app being installed but
    // `xcode-select` still pointing at the bare Command Line Tools (which don't ship simctl),
    // so a real booted simulator is invisible even though one's running right in front of you.
    return { devices: [], toolFound: false, needsXcodeSelect: xcodeAppInstalled() };
  }
}

/**
 * Detect all running mobile devices (Android + iOS), plus diagnostics distinguishing "tool not
 * found/runnable" from "tool ran fine, nothing's booted" so callers can give an accurate,
 * actionable message instead of always defaulting to "start an emulator".
 */
export function detectDevices(): DeviceDetectionResult {
  enrichMobileEnv();
  const android = detectAndroidDevices();
  const ios = detectIOSSimulators();
  return {
    devices: [...android.devices, ...ios.devices],
    diagnostics: {
      androidToolFound: android.toolFound,
      iosToolFound: ios.toolFound,
      iosNeedsXcodeSelect: ios.needsXcodeSelect,
    },
  };
}
