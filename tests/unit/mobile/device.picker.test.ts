/**
 * Unit tests for the mobile verify device-selection decision (`decideDevice`) —
 * the pure core of the picker. The I/O wrapper (`resolveVerifyDevice`) shells out
 * to adb/simctl and an interactive prompt, so it stays untested here by design.
 */
import { describe, it, expect } from 'vitest';
import { decideDevice } from '../../../src/infrastructure/mobile/device.picker.js';
import type {
  DeviceDetectionDiagnostics,
  MobileDevice,
} from '../../../src/infrastructure/mobile/device.detector.js';

// Both detection tools resolved fine — the common case, and what most of these tests exercise
// (device *selection* logic, not the diagnostics-driven "why is nothing detected" messaging).
const toolsFound: DeviceDetectionDiagnostics = {
  androidToolFound: true,
  iosToolFound: true,
  iosNeedsXcodeSelect: false,
};

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

describe('decideDevice', () => {
  it('an explicit id matching a detected device wins (recognized)', () => {
    const choice = decideDevice(
      [pixel7, pixel6],
      'emulator-5554',
      'android',
      '--device',
      toolsFound,
    );
    expect(choice).toEqual({ kind: 'explicit', device: pixel7, recognized: true });
  });

  it('an explicit name matching a detected device wins', () => {
    const choice = decideDevice([pixel7, pixel6], 'Pixel 6', 'android', '--device', toolsFound);
    expect(choice).toEqual({ kind: 'explicit', device: pixel6, recognized: true });
  });

  it('an explicit id wins even when nothing is detected (overrides detection blindness)', () => {
    const choice = decideDevice([], 'R5CT1234567', 'android', '--device', toolsFound);
    expect(choice.kind).toBe('explicit');
    if (choice.kind !== 'explicit') return;
    expect(choice.recognized).toBe(false);
    expect(choice.device).toEqual({
      id: 'R5CT1234567',
      name: 'R5CT1234567',
      platform: 'android',
      state: 'explicit',
    });
  });

  it('an explicit id missing among detected devices still wins, flagged unrecognized', () => {
    const choice = decideDevice([pixel7], 'emulator-9999', 'android', '--device', toolsFound);
    expect(choice.kind).toBe('explicit');
    if (choice.kind !== 'explicit') return;
    expect(choice.recognized).toBe(false);
    expect(choice.device.id).toBe('emulator-9999');
  });

  it('auto-selects the sole detected device', () => {
    const choice = decideDevice([iphone17], undefined, 'ios', '--udid', toolsFound);
    expect(choice).toEqual({ kind: 'auto', device: iphone17 });
  });

  it('reports multiple devices for a picker', () => {
    const choice = decideDevice([pixel7, pixel6], undefined, 'android', '--device', toolsFound);
    expect(choice.kind).toBe('multiple');
    if (choice.kind !== 'multiple') return;
    expect(choice.candidates).toEqual([pixel7, pixel6]);
  });

  it('reports none with a platform-specific reason when the tools ran fine', () => {
    const androidNone = decideDevice([], undefined, 'android', '--device', toolsFound);
    expect(androidNone.kind).toBe('none');
    if (androidNone.kind !== 'none') return;
    expect(androidNone.reason).toContain('Android');
    expect(androidNone.reason).toContain('--device');

    const iosNone = decideDevice([], undefined, 'ios', '--udid', toolsFound);
    expect(iosNone.kind).toBe('none');
    if (iosNone.kind !== 'none') return;
    expect(iosNone.reason).toContain('iOS Simulator');
    expect(iosNone.reason).toContain('--udid');
  });

  it('reports none with a PATH hint when adb could not be found at all', () => {
    const choice = decideDevice([], undefined, 'android', '--device', {
      androidToolFound: false,
      iosToolFound: true,
      iosNeedsXcodeSelect: false,
    });
    expect(choice.kind).toBe('none');
    if (choice.kind !== 'none') return;
    expect(choice.reason).toContain('adb');
    expect(choice.reason).toContain('PATH');
  });

  it('reports none with a xcode-select fix when Xcode is installed but misconfigured', () => {
    const choice = decideDevice([], undefined, 'ios', '--udid', {
      androidToolFound: true,
      iosToolFound: false,
      iosNeedsXcodeSelect: true,
    });
    expect(choice.kind).toBe('none');
    if (choice.kind !== 'none') return;
    expect(choice.reason).toContain('xcode-select -s');
  });
});
