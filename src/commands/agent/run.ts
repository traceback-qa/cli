import type { CliContext } from '../../types/context.js';
import { launchChrome } from '../../infrastructure/browser/chrome.launcher.js';
import { connectTunnel, type TunnelConnection } from '../../infrastructure/tunnel/tunnel.client.js';

export interface AgentRunResult {
  tunnelId: string;
  chromePath?: string;
}

/**
 * Run a local browser agent: launch Chrome, register its CDP URL with the backend
 * over the tunnel WebSocket, and keep the registration alive until interrupted.
 *
 * Exported separately from the commander wiring so it's unit-testable (the commander
 * action itself never returns, since the agent idles until Ctrl-C).
 *
 * @returns the tunnel id assigned by the backend
 */
export async function runBrowserAgent(
  ctx: CliContext,
  signal?: AbortSignal,
): Promise<{ tunnelId: string; close: () => void }> {
  const token = await ctx.infra.auth.getToken();
  if (!token?.accessToken) {
    throw new Error('No auth token found. Run `traceback login` first.');
  }

  const baseUrl = ctx.infra.api.getAxiosInstance().defaults.baseURL ?? 'http://localhost:8000';

  ctx.infra.ui.info('Launching Chrome…');
  const chrome = await launchChrome();

  ctx.infra.ui.info('Connecting to Traceback tunnel…');
  let tunnel: TunnelConnection;
  try {
    tunnel = await connectTunnel(baseUrl, token.accessToken, chrome.cdpUrl);
  } catch (err) {
    // Clean up Chrome if the tunnel connection itself fails.
    chrome.kill();
    throw err;
  }

  ctx.infra.ui.success(`Browser agent ready — tunnel id: ${tunnel.tunnelId}`);
  ctx.infra.ui.hint(
    'Keep this process running. Start browser-agent tests with this tunnel id. ' +
      'Press Ctrl-C to stop (the tunnel is cleaned up).',
  );

  const shutdown = () => {
    ctx.infra.ui.info('\nShutting down browser agent…');
    try {
      tunnel.close();
    } catch {
      /* already closed */
    }
    try {
      chrome.kill();
    } catch {
      /* already killed */
    }
    process.exit(0);
  };

  const onSignal = () => {
    shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Run until the process is interrupted, or the optional AbortSignal fires (tests use
  // this to stop the idle loop deterministically). The tunnel stays alive via heartbeat
  // pings, and the backend refreshes the TTL while this process is connected.
  await new Promise<void>((resolve) => {
    if (signal) {
      if (signal.aborted) {
        resolve();
      } else {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }
    }
  });

  return { tunnelId: tunnel.tunnelId, close: shutdown };
}
