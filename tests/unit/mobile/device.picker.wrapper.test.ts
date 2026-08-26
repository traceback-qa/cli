/**
 * Tests for the `resolveVerifyDevice` I/O wrapper — device detection and the
 * interactive prompt are mocked; everything the user actually sees (messages,
 * errors, the prompt choices) is exercised here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  DeviceDetectionDiagnostics,
  MobileDevice,
} from '../../../src/infrastructure/mobile/device.detector.js';

const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@inquirer/prompts', () => ({ select }));

const detectDevicesMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/infrastructure/mobile/device.detector.js', () => ({
  detectDevices: detectDevicesMock,
}));

import { resolveVerifyDevice } from '../../../src/infrastructure/mobile/device.picker.js';

// Both detection tools resolved fine — these tests exercise device *selection*, not the
// diagnostics-driven "why is nothing detected" messaging (that's covered in
// device.picker.test.ts's decideDevice unit tests).
const toolsFound: DeviceDetectionDiagnostics = {
  androidToolFound: true,
  iosToolFound: true,
  iosNeedsXcodeSelect: false,
};
/** Wraps a plain device list in the shape `detectDevices()` actually returns. */
function detected(devices: MobileDevice[]) {
  return { devices, diagnostics: toolsFound };
}

const pixel7: MobileDevice = {
  id: 'emulator-5554',
  name: 'Pixel 7',
  platform: 'android',
  state: 'device',
};
const pixel6: MobileDevice = {
  id: 'emulator-5556',
  name: 'Pixel 6',
  platform: 'android',
  state: 'device',
};
const iphone17: MobileDevice = {
  id: 'A3C3807E-1CE9-4CC0-B7A3-8900B5FD9F0A',
  name: 'iPhone 17',
  platform: 'ios',
  state: 'Booted',
};

function makeUi() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('resolveVerifyDevice', () => {
  beforeEach(() => {
    detectDevicesMock.mockReset();
    select.mockReset();
  });

  it('prompts for confirmation even with a single detected device (interactive)', async () => {
    detectDevicesMock.mockReturnValue(detected([pixel7]));
    select.mockResolvedValue(pixel7);
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'android',
      flagName: '--device',
      interactive: true,
      ui,
    });

    expect(device).toEqual(pixel7);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: [{ name: 'Pixel 7 (emulator-5554)', value: pixel7 }],
      }),
    );
  });

  it('auto-selects a single detected device without prompting when non-interactive', async () => {
    detectDevicesMock.mockReturnValue(detected([pixel7]));
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'android',
      flagName: '--device',
      interactive: false,
      ui,
    });

    expect(device).toEqual(pixel7);
    expect(ui.info).toHaveBeenCalledWith('Running against: Pixel 7 (emulator-5554)');
    expect(select).not.toHaveBeenCalled();
  });

  it('only considers devices of the requested platform', async () => {
    detectDevicesMock.mockReturnValue(detected([pixel7, iphone17]));
    select.mockResolvedValue(iphone17);
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'ios',
      flagName: '--udid',
      interactive: true,
      ui,
    });

    expect(device).toEqual(iphone17);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: [{ name: 'iPhone 17 (A3C3807E-1CE9-4CC0-B7A3-8900B5FD9F0A)', value: iphone17 }],
      }),
    );
  });

  it('fails with guidance when no devices are detected', async () => {
    detectDevicesMock.mockReturnValue(detected([]));
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'ios',
      flagName: '--udid',
      interactive: true,
      ui,
    });

    expect(device).toBeNull();
    expect(ui.error).toHaveBeenCalledWith(expect.stringContaining('No booted iOS Simulator'));
    expect(select).not.toHaveBeenCalled();
  });

  it('fails with the device list when multiple devices and non-interactive', async () => {
    detectDevicesMock.mockReturnValue(detected([pixel7, pixel6]));
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'android',
      flagName: '--device',
      interactive: false,
      ui,
    });

    expect(device).toBeNull();
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining('Pixel 7 (emulator-5554)') &&
        expect.stringContaining('--device') &&
        expect.stringContaining('Pixel 6 (emulator-5556)'),
    );
    expect(select).not.toHaveBeenCalled();
  });

  it('prompts for a pick when multiple devices and interactive', async () => {
    detectDevicesMock.mockReturnValue(detected([pixel7, pixel6]));
    select.mockResolvedValue(pixel6);
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'android',
      flagName: '--device',
      interactive: true,
      ui,
    });

    expect(device).toEqual(pixel6);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Select the device to run the test against:',
        choices: [
          { name: 'Pixel 7 (emulator-5554)', value: pixel7 },
          { name: 'Pixel 6 (emulator-5556)', value: pixel6 },
        ],
      }),
    );
  });

  it('an explicit id short-circuits detection and never prompts', async () => {
    detectDevicesMock.mockReturnValue(detected([pixel7, pixel6]));
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'android',
      flagName: '--device',
      explicitId: 'emulator-5554',
      interactive: true,
      ui,
    });

    expect(device).toEqual(pixel7);
    expect(select).not.toHaveBeenCalled();
    expect(ui.warn).not.toHaveBeenCalled();
  });

  it('warns when an explicit id is not among detected devices but still uses it', async () => {
    detectDevicesMock.mockReturnValue(detected([pixel7]));
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'android',
      flagName: '--device',
      explicitId: 'emulator-9999',
      interactive: true,
      ui,
    });

    expect(device?.id).toBe('emulator-9999');
    expect(ui.warn).toHaveBeenCalledWith(expect.stringContaining('emulator-9999'));
  });

  it('uses an explicit id even when detection found nothing (no warning)', async () => {
    detectDevicesMock.mockReturnValue(detected([]));
    const ui = makeUi();

    const device = await resolveVerifyDevice({
      platform: 'ios',
      flagName: '--udid',
      explicitId: iphone17.id,
      interactive: false,
      ui,
    });

    expect(device?.id).toBe(iphone17.id);
    expect(ui.warn).not.toHaveBeenCalled();
    expect(ui.error).not.toHaveBeenCalled();
  });
});
