/**
 * Unit tests for simctl path resolution — the piece that keeps iOS device
 * detection working when `xcode-select` points at Command Line Tools.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { simctlCandidatePaths } from '../../../src/infrastructure/mobile/simctl.js';

describe('simctlCandidatePaths', () => {
  it('skips a Command Line Tools xcode-select output (it has no simctl)', () => {
    const candidates = simctlCandidatePaths('/Library/Developer/CommandLineTools', '/Users/x');
    expect(candidates.some((c) => c.includes('CommandLineTools'))).toBe(false);
  });

  it('puts a real Xcode developer dir first', () => {
    const candidates = simctlCandidatePaths(
      '/Applications/Xcode.app/Contents/Developer',
      '/Users/x',
    );
    expect(candidates[0]).toBe(
      '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl',
    );
  });

  it('respects DEVELOPER_DIR when xcode-select is unusable', () => {
    const candidates = simctlCandidatePaths(null, '/Users/x', '/opt/Xcode.app/Contents/Developer');
    expect(candidates[0]).toBe('/opt/Xcode.app/Contents/Developer/usr/bin/simctl');
  });

  it('includes the standard locations as fallbacks', () => {
    const candidates = simctlCandidatePaths(null, '/Users/x');
    expect(candidates).toContain('/Applications/Xcode.app/Contents/Developer/usr/bin/simctl');
    expect(candidates).toContain(
      path.join('/Users/x', 'Applications', 'Xcode.app', 'Contents', 'Developer', 'usr', 'bin', 'simctl'),
    );
    expect(candidates).toContain('/Applications/Xcode-beta.app/Contents/Developer/usr/bin/simctl');
  });

  it('dedupes repeated candidates', () => {
    const candidates = simctlCandidatePaths(
      '/Applications/Xcode.app/Contents/Developer',
      '/Users/x',
      '/Applications/Xcode.app/Contents/Developer',
    );
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
