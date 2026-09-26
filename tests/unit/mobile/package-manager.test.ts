import { describe, it, expect } from 'vitest';
import {
  detectPackageManager,
  getPackageInstallPlan,
  getIsolatedNpmDirs,
} from '../../../src/infrastructure/mobile/package-manager.js';

describe('package-manager helper', () => {
  describe('detectPackageManager', () => {
    it('returns package manager info or null', () => {
      const pm = detectPackageManager();
      if (pm) {
        expect(['brew', 'winget', 'choco']).toContain(pm.manager);
        expect(typeof pm.binPath).toBe('string');
      } else {
        expect(pm).toBeNull();
      }
    });
  });

  describe('getPackageInstallPlan', () => {
    it('returns valid brew install plans', () => {
      const brewPm = { manager: 'brew' as const, binPath: 'brew' };

      const javaPlan = getPackageInstallPlan('java', brewPm);
      expect(javaPlan).not.toBeNull();
      expect(javaPlan?.args).toContain('openjdk@17');

      const androidPlan = getPackageInstallPlan('android-sdk', brewPm);
      expect(androidPlan).not.toBeNull();
      expect(androidPlan?.args).toContain('android-platform-tools');

      const ffmpegPlan = getPackageInstallPlan('ffmpeg', brewPm);
      expect(ffmpegPlan).not.toBeNull();
      expect(ffmpegPlan?.args).toContain('ffmpeg');
    });

    it('returns valid winget install plans', () => {
      const wingetPm = { manager: 'winget' as const, binPath: 'winget' };

      const javaPlan = getPackageInstallPlan('java', wingetPm);
      expect(javaPlan).not.toBeNull();
      expect(javaPlan?.args).toContain('Microsoft.OpenJDK.17');

      const androidPlan = getPackageInstallPlan('android-sdk', wingetPm);
      expect(androidPlan).not.toBeNull();
      expect(androidPlan?.args).toContain('Google.PlatformTools');
    });

    it('returns null when no package manager is provided or detected', () => {
      const nullPlan = getPackageInstallPlan('java', null);
      expect(nullPlan).toBeNull();
    });
  });

  describe('getIsolatedNpmDirs', () => {
    it('returns isolated user directories for npm and bin', () => {
      const dirs = getIsolatedNpmDirs();
      expect(dirs.dataDir).toBeDefined();
      expect(dirs.binDir).toContain('bin');
      expect(dirs.npmPrefix).toContain('npm');
      expect(dirs.npmBinDir).toBeDefined();
      expect(dirs.npmModulesBinDir).toContain('node_modules');
    });
  });
});
