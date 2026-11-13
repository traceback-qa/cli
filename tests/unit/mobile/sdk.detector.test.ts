import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultAndroidHomeCandidates,
  findAndroidSdk,
  enrichMobileEnv,
  checkProfileHasEnv,
  writeMobileEnvToShellProfile,
} from '../../../src/infrastructure/mobile/sdk.detector.js';

describe('sdk.detector', () => {
  const originalEnv = { ...process.env };
  const tempDir = path.join(os.tmpdir(), `traceback-sdk-test-${Date.now()}`);

  beforeEach(() => {
    process.env = { ...originalEnv };
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('defaultAndroidHomeCandidates', () => {
    it('returns platform-appropriate candidate paths', () => {
      const candidates = defaultAndroidHomeCandidates();
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThan(0);
    });
  });

  describe('findAndroidSdk', () => {
    it('detects SDK from custom directory', () => {
      const mockSdk = path.join(tempDir, 'mock-sdk');
      const platformTools = path.join(mockSdk, 'platform-tools');
      fs.mkdirSync(platformTools, { recursive: true });
      const adbBin = process.platform === 'win32' ? 'adb.exe' : 'adb';
      fs.writeFileSync(path.join(platformTools, adbBin), '#!/bin/sh\nexit 0', { mode: 0o755 });

      process.env.ANDROID_HOME = mockSdk;
      const result = findAndroidSdk();
      expect(result).not.toBeNull();
      expect(result?.sdkPath).toBe(mockSdk);
      expect(result?.isCustom).toBe(true);
    });
  });

  describe('enrichMobileEnv', () => {
    it('sets ANDROID_HOME in process.env when SDK is found', () => {
      const mockSdk = path.join(tempDir, 'mock-sdk-enrich');
      const platformTools = path.join(mockSdk, 'platform-tools');
      fs.mkdirSync(platformTools, { recursive: true });
      const adbBin = process.platform === 'win32' ? 'adb.exe' : 'adb';
      fs.writeFileSync(path.join(platformTools, adbBin), '#!/bin/sh\nexit 0', { mode: 0o755 });

      delete process.env.ANDROID_HOME;
      delete process.env.ANDROID_SDK_ROOT;

      // Mock candidates by setting ANDROID_HOME temporarily to verify enrichment
      process.env.ANDROID_HOME = mockSdk;
      enrichMobileEnv();

      expect(process.env.ANDROID_SDK_ROOT).toBe(mockSdk);
      expect(process.env.PATH).toContain(platformTools);
    });
  });

  describe('checkProfileHasEnv & writeMobileEnvToShellProfile', () => {
    it('detects missing env and writes exports', () => {
      const profilePath = path.join(tempDir, '.mockzshrc');
      fs.writeFileSync(profilePath, '# empty\n', 'utf-8');

      const initialStatus = checkProfileHasEnv(profilePath);
      expect(initialStatus.hasAndroid).toBe(false);
      expect(initialStatus.hasJava).toBe(false);

      const written = writeMobileEnvToShellProfile(
        profilePath,
        '/mock/android/sdk',
        '/mock/java/home',
      );
      expect(written).toBe(true);

      const updatedContent = fs.readFileSync(profilePath, 'utf-8');
      expect(updatedContent).toContain('export ANDROID_HOME="/mock/android/sdk"');
      expect(updatedContent).toContain('export JAVA_HOME="/mock/java/home"');

      const newStatus = checkProfileHasEnv(profilePath);
      expect(newStatus.hasAndroid).toBe(true);
      expect(newStatus.hasJava).toBe(true);
    });
  });
});
