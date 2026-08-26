import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runBrowserAgent } from '../../../src/commands/agent/run.js';

// Mock the heavy deps so the command doesn't actually launch Chrome or open a socket.
vi.mock('../../../src/infrastructure/browser/chrome.launcher.js', () => ({
  launchChrome: vi.fn(),
}));
vi.mock('../../../src/infrastructure/tunnel/tunnel.client.js', () => ({
  connectTunnel: vi.fn(),
}));

import { launchChrome } from '../../../src/infrastructure/browser/chrome.launcher.js';
import { connectTunnel } from '../../../src/infrastructure/tunnel/tunnel.client.js';

function makeCtx() {
  const ui = {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    hint: vi.fn(),
    spinner: vi.fn(() => ({ stop: vi.fn(), fail: vi.fn() })),
    renderJson: vi.fn(),
    table: vi.fn(),
  };

  return {
    flags: { json: false, silent: false },
    infra: {
      ui,
      auth: { getToken: vi.fn().mockResolvedValue({ accessToken: 'tbk_test_token' }) },
      api: {
        getAxiosInstance: () => ({ defaults: { baseURL: 'http://localhost:8000/api/v1' } }),
      },
    },
    services: {},
  };
}

describe('runBrowserAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (launchChrome as ReturnType<typeof vi.fn>).mockResolvedValue({
      process: { kill: vi.fn() },
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
      kill: vi.fn(),
    });
    (connectTunnel as ReturnType<typeof vi.fn>).mockResolvedValue({
      tunnelId: 'tun-123',
      close: vi.fn(),
    });
  });

  it('launches Chrome, connects the tunnel, and reports the tunnel id', async () => {
    const ctx = makeCtx();
    const ac = new AbortController();
    const resultPromise = runBrowserAgent(ctx, ac.signal);

    // Give it a tick so the async flow reaches the idle promise
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    const result = await resultPromise;

    expect(result.tunnelId).toBe('tun-123');
    expect(launchChrome).toHaveBeenCalledOnce();
    expect(connectTunnel).toHaveBeenCalledWith(
      'http://localhost:8000/api/v1',
      'tbk_test_token',
      'ws://127.0.0.1:9222/devtools/browser/abc',
    );
    expect(ctx.infra.ui.success).toHaveBeenCalledWith(
      expect.stringContaining('tunnel id: tun-123'),
    );
    expect(ctx.infra.ui.hint).toHaveBeenCalled();
  });

  it('throws with a friendly error when not authenticated', async () => {
    const ctx = makeCtx();
    ctx.infra.auth.getToken.mockResolvedValue(null);

    await expect(runBrowserAgent(ctx, new AbortController().signal)).rejects.toThrow(/login/);
    expect(launchChrome).not.toHaveBeenCalled();
  });

  it('cleans up Chrome when the tunnel connection fails', async () => {
    (connectTunnel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Tunnel connection failed'),
    );
    const ctx = makeCtx();

    await expect(runBrowserAgent(ctx, new AbortController().signal)).rejects.toThrow(
      /Tunnel connection failed/,
    );
    expect(launchChrome.mock.results[0]?.value?.kill).toHaveBeenCalled();
  });
});
