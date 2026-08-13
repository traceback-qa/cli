/**
 * Device selection for `traceback mobile verify` — decide which device a run targets.
 *
 * Priority:
 *   1. An explicit device id (`--udid` / `--device`) always wins — even when we can't
 *      detect it (adb/simctl missing, device not booted yet), the user gets to override
 *      our blindness rather than being blocked by it.
 *   2. Exactly one detected device for the platform → auto-select it.
 *   3. Several → prompt the user to pick (or fail with the list in non-interactive
 *      modes like `--json`/`--silent`, where a prompt would hang).
 *   4. None → a clear, platform-specific error instead of an opaque Appium failure.
 *
 * `decideDevice` is the pure, unit-testable core; `resolveVerifyDevice` is the I/O
 * wrapper (device detection + optional interactive prompt).
 */

import { detectDevices, type MobileDevice } from './device.detector.js';
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

function noneReason(platform: 'android' | 'ios', flagName: string): string {
  return platform === 'android'
    ? `No Android devices found. Start an emulator or plug in a device, and make sure \`adb\` is on your PATH — or pass ${flagName} <id> to target one anyway.`
    : `No booted iOS Simulator found. Open one (e.g. \`open -a Simulator\`), then retry — or pass ${flagName} <device-id> to target one anyway.`;
}

/** Pure decision logic: what to do given the detected candidates for a platform. */
export function decideDevice(
  candidates: MobileDevice[],
  explicitId: string | undefined,
  platform: 'android' | 'ios',
  flagName: '--udid' | '--device',
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
    return { kind: 'none', reason: noneReason(platform, flagName) };
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
  const candidates = detectDevices().filter((d) => d.platform === opts.platform);
  const choice = decideDevice(candidates, opts.explicitId, opts.platform, opts.flagName);

  switch (choice.kind) {
    case 'explicit':
      if (!choice.recognized && candidates.length > 0) {
        opts.ui.warn(
          `Device "${opts.explicitId}" was not found among detected ${opts.platform} devices — using it anyway.`,
        );
      }
      return choice.device;
    case 'auto':
      opts.ui.info(`Running against: ${choice.device.name} (${choice.device.id})`);
      return choice.device;
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
