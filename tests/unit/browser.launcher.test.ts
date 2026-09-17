import { describe, it, expect } from 'vitest';
import { findChromiumBrowser } from '../../src/infrastructure/browser/chrome.launcher.js';

describe('Chrome / Chromium Browser Launcher', () => {
  it('should find an installed Chromium-compatible browser or custom override', () => {
    const browser = findChromiumBrowser();
    if (browser) {
      expect(browser.name).toBeDefined();
      expect(browser.executablePath).toBeDefined();
      expect(typeof browser.name).toBe('string');
      expect(typeof browser.executablePath).toBe('string');
    }
  });

  it('should respect TRACEBACK_BROWSER_PATH env override', () => {
    const originalEnv = process.env.TRACEBACK_BROWSER_PATH;
    try {
      // Using an existing executable (node binary) just to test path discovery
      process.env.TRACEBACK_BROWSER_PATH = process.execPath;
      const browser = findChromiumBrowser();
      expect(browser).not.toBeNull();
      expect(browser?.name).toBe('Custom Chromium');
      expect(browser?.executablePath).toBe(process.execPath);
    } finally {
      process.env.TRACEBACK_BROWSER_PATH = originalEnv;
    }
  });
});
