import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  isAppiumRunning,
  ensureAppiumServer,
  commandExists,
} from '../../../src/infrastructure/mobile/appium.server.js';

describe('appium.server', () => {
  describe('isAppiumRunning', () => {
    let server: http.Server | null = null;
    let serverPort: number;

    beforeEach(async () => {
      await new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ value: { ready: true, message: 'Ready' } }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server?.address();
          if (addr && typeof addr === 'object') {
            serverPort = addr.port;
          }
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        server = null;
      }
    });

    it('returns true when Appium /status returns 200', async () => {
      const running = await isAppiumRunning(`http://127.0.0.1:${serverPort}`, 1000);
      expect(running).toBe(true);
    });

    it('returns false when target port is not listening', async () => {
      const running = await isAppiumRunning('http://127.0.0.1:59999', 500);
      expect(running).toBe(false);
    });
  });

  describe('ensureAppiumServer with existing server', () => {
    let server: http.Server | null = null;
    let serverPort: number;

    beforeEach(async () => {
      await new Promise<void>((resolve) => {
        server = http.createServer((req, res) => {
          if (req.url === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ value: { ready: true } }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.listen(0, '127.0.0.1', () => {
          const addr = server?.address();
          if (addr && typeof addr === 'object') {
            serverPort = addr.port;
          }
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        server = null;
      }
    });

    it('reuses running server and does not kill it on stop()', async () => {
      const handle = await ensureAppiumServer({
        appiumUrl: `http://127.0.0.1:${serverPort}`,
      });

      expect(handle.startedByUs).toBe(false);
      expect(handle.url).toBe(`http://127.0.0.1:${serverPort}`);

      // stop should be a safe no-op
      await handle.stop();

      // server is still alive
      const stillRunning = await isAppiumRunning(`http://127.0.0.1:${serverPort}`, 500);
      expect(stillRunning).toBe(true);
    });
  });

  describe('commandExists', () => {
    it('returns true for existing system commands', () => {
      expect(commandExists('node')).toBe(true);
    });

    it('returns false for nonexistent commands', () => {
      expect(commandExists('nonexistent_traceback_test_cmd_12345')).toBe(false);
    });
  });
});
