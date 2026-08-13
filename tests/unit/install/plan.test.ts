/**
 * Unit tests for `traceback install`'s plan builder — the pure detection → steps
 * logic that decides what gets installed, confirmed, or printed as guidance.
 */
import { describe, it, expect } from 'vitest';
import { buildInstallPlan, type ToolPresence } from '../../../src/commands/install/plan.js';

const NONE: ToolPresence = {
  brew: false,
  node: false,
  npm: false,
  appium: false,
  java: false,
  adb: false,
  androidStudio: false,
  xcodeClt: false,
  xcodeFull: false,
  flutter: false,
};

const ALL: ToolPresence = {
  brew: true,
  node: true,
  npm: true,
  appium: true,
  java: true,
  adb: true,
  androidStudio: true,
  xcodeClt: true,
  xcodeFull: true,
  flutter: true,
};

describe('buildInstallPlan (macOS)', () => {
  it('lists every tool in dependency order when nothing is installed', () => {
    const plan = buildInstallPlan('darwin', NONE);
    expect(plan.map((s) => s.id)).toEqual([
      'homebrew',
      'node',
      'appium',
      'java',
      'android',
      'ios',
      'flutter',
    ]);
    expect(plan.every((s) => !s.present)).toBe(true);
    expect(plan.every((s) => s.action === 'install')).toBe(true);
  });

  it('marks everything present when the full toolchain exists', () => {
    const plan = buildInstallPlan('darwin', ALL);
    expect(plan.every((s) => s.present)).toBe(true);
  });

  it('considers Android installed only when adb AND Studio/SDK are present', () => {
    const partial: ToolPresence = { ...ALL, adb: false };
    const plan = buildInstallPlan('darwin', partial);
    expect(plan.find((s) => s.id === 'android')?.present).toBe(false);
  });

  it('switches iOS to guidance when only the Command Line Tools are present', () => {
    const partial: ToolPresence = { ...ALL, xcodeFull: false };
    const plan = buildInstallPlan('darwin', partial);
    const ios = plan.find((s) => s.id === 'ios');
    expect(ios?.present).toBe(false);
    expect(ios?.action).toBe('guidance');
  });

  it('gives no-Homebrew alternatives in the guidance for brew-based tools', () => {
    const plan = buildInstallPlan('darwin', NONE);
    expect(plan.find((s) => s.id === 'node')?.guidance.join(' ')).toContain('nodejs.org');
    expect(plan.find((s) => s.id === 'java')?.guidance.join(' ')).toContain('adoptium.net');
    expect(plan.find((s) => s.id === 'android')?.guidance.join(' ')).toContain(
      'developer.android.com',
    );
    expect(plan.find((s) => s.id === 'flutter')?.guidance.join(' ')).toContain('flutter.dev');
  });

  it('respects the --skip list', () => {
    const plan = buildInstallPlan('darwin', NONE, ['flutter', 'ios']);
    expect(plan.map((s) => s.id)).not.toContain('flutter');
    expect(plan.map((s) => s.id)).not.toContain('ios');
    expect(plan.map((s) => s.id)).toContain('android');
  });
});

describe('buildInstallPlan (non-macOS)', () => {
  it('auto-installs only the pure-npm appium step; everything else is guidance with apt hints', () => {
    const plan = buildInstallPlan('linux', NONE);
    for (const step of plan) {
      if (step.id === 'appium') {
        expect(step.action).toBe('install');
      } else {
        expect(step.action).toBe('guidance');
        expect(step.guidance.length).toBeGreaterThan(0);
      }
    }
    // Node on Linux must NOT be auto-installed via brew — apt guidance instead.
    const node = plan.find((s) => s.id === 'node');
    expect(node?.action).toBe('guidance');
    expect(node?.guidance.join(' ')).toContain('apt');
  });
});
