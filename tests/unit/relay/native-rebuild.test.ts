/**
 * Unit tests for the native rebuild runner — the "live update" for iOS/Kotlin.
 * These exercise the dry-run paths (no real toolchains), which still validate the
 * option validation and the built/failed result shaping.
 */
import { describe, it, expect } from 'vitest';
import { runNativeRebuild } from '../../../src/commands/tunnel/native-rebuild.js';

describe('runNativeRebuild (dry-run)', () => {
  it('reports a built iOS rebuild when project + scheme are given', async () => {
    const lines: string[] = [];
    const result = await runNativeRebuild({
      framework: 'ios',
      project: 'ios/App.xcodeproj',
      scheme: 'App',
      dryRun: true,
      onLine: (line) => lines.push(line),
    });

    expect(result.status).toBe('built');
    expect(result.framework).toBe('ios');
    expect(result.durationMs).toBeTypeOf('number');
    expect(result.message).toContain('[dry-run]');
    expect(lines.some((l) => l.includes('xcodebuild'))).toBe(true);
  });

  it('fails iOS rebuild without project/scheme (no dry-run escape hatch)', async () => {
    const result = await runNativeRebuild({ framework: 'ios', dryRun: true });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('--project');
  });

  it('reports a built kotlin rebuild when package is given', async () => {
    const result = await runNativeRebuild({
      framework: 'kotlin',
      packageName: 'com.example.app',
      dryRun: true,
    });

    expect(result.status).toBe('built');
    expect(result.framework).toBe('kotlin');
    expect(result.message).toContain('com.example.app');
  });

  it('fails kotlin rebuild without a package name', async () => {
    const result = await runNativeRebuild({ framework: 'kotlin', dryRun: true });
    expect(result.status).toBe('failed');
    expect(result.message).toContain('--package');
  });
});
