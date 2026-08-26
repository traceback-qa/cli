/**
 * Device selection for `traceback mobile verify` — decide which device a run targets.
 *
 * Priority:
 *   1. An explicit device id (`--udid` / `--device`) always wins — even when we can't
 *      detect it (adb/simctl missing, device not booted yet), the user gets to override
 *      our blindness rather than being blocked by it.
 *   2. One or more detected devices for the platform → prompt the user to pick, even when
 *      there's only one candidate (an explicit confirmation, not an automatic run against
 *      whatever happens to be booted) — or fail with the list in non-interactive modes like
 *      `--json`/`--silent`, where a prompt would hang (a lone candidate is used there with no
 *      one to ask).
 *   3. None → a clear, platform-specific error instead of an opaque Appium failure.
 *
 * `decideDevice` is the pure, unit-testable core; `resolveVerifyDevice` is the I/O
 * wrapper (device detection + optional interactive prompt).
 */

import {
  detectDevices,
  type DeviceDetectionDiagnostics,
  type MobileDevice,
} from './device.detector.js';
import type { UIService } from '../ui/ui.types.js';

export type DeviceChoice =
  | { kind: 'explicit'; device: MobileDevice; recognized: boolean }
  | { kind: 'auto'; device: MobileDevice }
  | { kind: 'multiple'; candidates: MobileDevice[] }
  | { kind: 'none'; reason: string };

export interface ResolveVerifyDeviceOptions {
  platform: 'android' | 'ios';
  /** Device id (or name) from `--udid` / `--device`, if the user pinned one. */
  explicitId?: string;
  /** The flag the user would type — used in error messages. */
  flagName: '--udid' | '--device';
  /** False in `--json` / `--silent` modes, where an interactive prompt would hang. */
  interactive: boolean;
  ui: Pick<UIService, 'info' | 'warn' | 'error'>;
}

/** Distinguishes "the detector couldn't even find/run `adb`/`xcrun`" (most often a stale
 * terminal's PATH not having picked up a just-installed Android Studio/Xcode) from "it ran
 * fine, nothing's just booted" — those need different fixes, so they get different messages. */
function noneReason(
  platform: 'android' | 'ios',
  flagName: string,
  diagnostics: DeviceDetectionDiagnostics,
): string {
  if (platform === 'android' && !diagnostics.androidToolFound) {
    return (
      "Couldn't find `adb` on your PATH. If you just installed Android Studio, open a new " +
      `terminal (PATH changes don't apply to one already open) — or pass ${flagName} <id> to target a device anyway.`
    );
  }
  if (platform === 'ios' && !diagnostics.iosToolFound) {
    return diagnostics.iosNeedsXcodeSelect
      ? 'Xcode is installed, but `xcode-select` still points at the bare Command Line Tools, ' +
          "which can't see the Simulator. Fix it with: " +
          `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer — or pass ${flagName} <device-id> to target one anyway.`
      : `Couldn't run \`xcrun\` — is Xcode or the Command Line Tools installed? Install them with ` +
          `\`xcode-select --install\`, or pass ${flagName} <device-id> to target one anyway.`;
  }
  return platform === 'android'
    ? `No Android devices found. Start an emulator or plug in a device — or pass ${flagName} <id> to target one anyway.`
    : `No booted iOS Simulator found. Open one (e.g. \`open -a Simulator\`), then retry — or pass ${flagName} <device-id> to target one anyway.`;
}

/** Pure decision logic: what to do given the detected candidates for a platform. */
export function decideDevice(
  candidates: MobileDevice[],
  explicitId: string | undefined,
  platform: 'android' | 'ios',
  flagName: '--udid' | '--device',
  diagnostics: DeviceDetectionDiagnostics,
): DeviceChoice {
  if (explicitId) {
    const match = candidates.find((d) => d.id === explicitId || d.name === explicitId);
    if (match) return { kind: 'explicit', device: match, recognized: true };
    return {
      kind: 'explicit',
      recognized: false,
      device: { id: explicitId, name: explicitId, platform, state: 'explicit' },
    };
  }
  if (candidates.length === 0) {
    return { kind: 'none', reason: noneReason(platform, flagName, diagnostics) };
  }
  if (candidates.length === 1) {
    return { kind: 'auto', device: candidates[0]! };
  }
  return { kind: 'multiple', candidates };
}

/** Resolve the device a verify run targets, prompting when the choice is ambiguous. */
export async function resolveVerifyDevice(
  opts: ResolveVerifyDeviceOptions,
): Promise<MobileDevice | null> {
  const { devices, diagnostics } = detectDevices();
  const candidates = devices.filter((d) => d.platform === opts.platform);
  const choice = decideDevice(
    candidates,
    opts.explicitId,
    opts.platform,
    opts.flagName,
    diagnostics,
  );

  switch (choice.kind) {
    case 'explicit':
      if (!choice.recognized && candidates.length > 0) {
        opts.ui.warn(
          `Device "${opts.explicitId}" was not found among detected ${opts.platform} devices — using it anyway.`,
        );
      }
      return choice.device;
    case 'auto': {
      // A single detected device still isn't picked silently in interactive mode — an explicit
      // confirmation, not an automatic run, since starting against the wrong device (a stale
      // emulator, a colleague's real phone) is much more surprising to undo than one keypress.
      // Non-interactive (`--json`/`--silent`/CI) has no one to prompt, so it keeps using the
      // sole candidate and just says so.
      if (!opts.interactive) {
        opts.ui.info(`Running against: ${choice.device.name} (${choice.device.id})`);
        return choice.device;
      }
      const { select } = await import('@inquirer/prompts');
      return await select<MobileDevice>({
        message: 'Select the device to run the test against:',
        choices: [{ name: `${choice.device.name} (${choice.device.id})`, value: choice.device }],
      });
    }
    case 'none':
      opts.ui.error(choice.reason);
      return null;
    case 'multiple': {
      if (!opts.interactive) {
        opts.ui.error(
          `Multiple ${opts.platform} devices detected — pass ${opts.flagName} <id> to pick one:\n` +
            choice.candidates.map((d) => `  - ${d.name} (${d.id})`).join('\n'),
        );
        return null;
      }
      const { select } = await import('@inquirer/prompts');
      return await select<MobileDevice>({
        message: 'Select the device to run the test against:',
        choices: choice.candidates.map((d) => ({ name: `${d.name} (${d.id})`, value: d })),
      });
    }
  }
}
