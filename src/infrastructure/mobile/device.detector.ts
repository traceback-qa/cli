/**
 * Device Detector — finds running Android emulators and iOS simulators.
 *
 * Uses platform-native tools:
 *   - Android: `adb devices` to list connected emulators/devices
 *   - iOS: `xcrun simctl list devices booted` to list running simulators
 *
 * Returns a unified list of devices the user can pick from.
 */

import { execFileSync, execSync } from 'node:child_process';
import { resolveSimctlPathSync } from './simctl.js';

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

/**
 * Detect running Android emulators and connected devices via `adb devices`.
 *
 * Output format of `adb devices`:
 *   List of devices attached
 *   emulator-5554	device
 *   R5CT1234567	device
 */
function detectAndroidDevices(): MobileDevice[] {
  try {
    const output = execSync('adb devices -l', {
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
      const name = modelName
        ? modelName.replace(/_/g, ' ')
        : id.startsWith('emulator')
          ? `Android Emulator (${id})`
          : `Android Device (${id})`;

      devices.push({
        id,
        name,
        platform: 'android' as const,
        state: 'device',
      });
    }

    return devices;
  } catch {
    // adb not installed or not in PATH
    return [];
  }
}

/**
 * Detect running iOS simulators via `simctl list devices booted`.
 *
 * Uses the ABSOLUTE simctl path (resolved from a real Xcode install) instead of
 * `xcrun simctl`, because `xcrun` only works when `xcode-select` points at a real
 * Xcode — machines with the active developer dir set to Command Line Tools (which
 * has no simctl) would otherwise silently report zero simulators.
 *
 * Output format:
 *   == Devices ==
 *   -- iOS 17.5 --
 *       iPhone 15 Pro (ABCD-1234-...) (Booted)
 */
function detectIOSSimulators(): MobileDevice[] {
  // Only available on macOS
  if (process.platform !== 'darwin') return [];

  const simctl = resolveSimctlPathSync();
  if (!simctl) return [];

  try {
    const output = execFileSync(simctl, ['list', 'devices', 'booted'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
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

    return devices;
  } catch {
    // Xcode not installed
    return [];
  }
}

/**
 * Detect all running mobile devices (Android + iOS).
 * Returns an empty array if no devices/emulators are running.
 */
export function detectDevices(): MobileDevice[] {
  return [...detectAndroidDevices(), ...detectIOSSimulators()];
}
