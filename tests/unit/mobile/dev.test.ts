/**
 * Unit tests for `mobile dev`'s project detection — the framework label the backend
 * uses to decide HOW to bring up the cloud emulator (Expo Go vs a Flutter debug APK).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectFlutterPackage,
  detectFramework,
  resolveAdbPath,
} from '../../../src/commands/mobile/dev.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'dev-detect-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('detectFramework', () => {
  it('detects Flutter from pubspec.yaml (sdk: flutter)', async () => {
    await writeFile(
      path.join(cwd, 'pubspec.yaml'),
      ['name: demo', 'dependencies:', '  flutter:', '    sdk: flutter'].join('\n'),
    );
    expect(await detectFramework(cwd)).toEqual({ framework: 'flutter' });
  });

  it('detects expo with its SDK version from package.json', async () => {
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { expo: '^57.0.0', 'react-native': '0.79.0' } }),
    );
    expect(await detectFramework(cwd)).toEqual({ framework: 'expo', sdkVersion: '57' });
  });

  it('detects bare react-native (no expo) from package.json', async () => {
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { 'react-native': '0.79.0' } }),
    );
    expect(await detectFramework(cwd)).toEqual({ framework: 'react-native' });
  });

  it('falls back to expo when nothing is detected', async () => {
    expect(await detectFramework(cwd)).toEqual({ framework: 'expo' });
  });

  it('prefers Flutter even when a stray package.json also exists', async () => {
    await writeFile(
      path.join(cwd, 'pubspec.yaml'),
      ['dependencies:', '  flutter:', '    sdk: flutter'].join('\n'),
    );
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { expo: '^57.0.0' } }),
    );
    expect(await detectFramework(cwd)).toEqual({ framework: 'flutter' });
  });
});

describe('detectFlutterPackage', () => {
  it('parses the namespace from build.gradle.kts', async () => {
    const dir = path.join(cwd, 'android', 'app');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'build.gradle.kts'),
      ['android {', '    namespace = "com.example.flutter_demo"', '}'].join('\n'),
    );
    expect(await detectFlutterPackage(cwd)).toBe('com.example.flutter_demo');
  });

  it('returns undefined when no gradle file exists', async () => {
    expect(await detectFlutterPackage(cwd)).toBeUndefined();
  });
});

describe('resolveAdbPath', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  async function makeFakeSdk(root: string): Promise<string> {
    const dir = path.join(root, 'platform-tools');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'adb'), '');
    return path.join(dir, 'adb');
  }

  it('prefers ANDROID_HOME/platform-tools/adb when adb is not on PATH', async () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.ANDROID_HOME = cwd;
    process.env.ANDROID_SDK_ROOT = undefined;
    const expected = await makeFakeSdk(cwd);
    expect(resolveAdbPath(path.join(cwd, 'home'))).toBe(expected);
  });

  it('falls back to ANDROID_SDK_ROOT when ANDROID_HOME is unset', async () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.ANDROID_HOME = undefined;
    process.env.ANDROID_SDK_ROOT = cwd;
    const expected = await makeFakeSdk(cwd);
    expect(resolveAdbPath(path.join(cwd, 'home'))).toBe(expected);
  });

  it('falls back to the default macOS SDK location', async () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.ANDROID_HOME = undefined;
    process.env.ANDROID_SDK_ROOT = undefined;
    const sdkRoot = path.join(cwd, 'Library', 'Android', 'sdk');
    const expected = await makeFakeSdk(sdkRoot);
    expect(resolveAdbPath(cwd)).toBe(expected);
  });

  it('returns null when nothing resolves', () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.ANDROID_HOME = undefined;
    process.env.ANDROID_SDK_ROOT = undefined;
    expect(resolveAdbPath(path.join(cwd, 'home'))).toBeNull();
  });
});
