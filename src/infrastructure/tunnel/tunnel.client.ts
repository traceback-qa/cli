/**
 * Tunnel Client — connects to the backend's WebSocket tunnel.
 *
 * The tunnel is the bridge between the user's local Chrome and the
 * backend's test execution worker. The flow:
 *
 *   1. CLI opens a WebSocket to /tunnel/connect?token=xxx on the backend
 *   2. Backend verifies the token and assigns a tunnel_id
 *   3. CLI sends a `cdp_ready` message with the local Chrome's CDP URL
 *   4. Backend stores the CDP URL in the tunnel registry
 *   5. When a test run is dispatched with this tunnel_id, the worker
 *      looks up the CDP URL and connects to the user's Chrome
 *
 * The tunnel stays open for the duration of the local run. When the
 * CLI disconnects, the backend cleans up the tunnel entry.
 */

import WebSocket from 'ws';

export interface TunnelConnection {
  /** The tunnel ID assigned by the backend. */
  tunnelId: string;
  /** Close the tunnel connection. */
  close: () => void;
}

/**
 * Connect to the backend's tunnel gateway and advertise a CDP URL.
 *
 * @param apiBaseUrl  The backend API base URL (e.g. http://localhost:8000/api/v1)
 * @param authToken   The CLI auth token (tb_xxx)
 * @param cdpUrl      The local Chrome CDP WebSocket URL
 * @returns           A tunnel connection with the assigned tunnel_id
 */
export async function connectTunnel(
  apiBaseUrl: string,
  authToken: string,
  cdpUrl: string,
): Promise<TunnelConnection> {
  // Build WebSocket URL with token as query param.
  // e.g. http://localhost:8000/api/v1 → ws://localhost:8000/api/v1/tunnel/connect?token=tb_xxx
  const wsUrl =
    apiBaseUrl.replace(/^http/, 'ws') + `/tunnel/connect?token=${encodeURIComponent(authToken)}`;

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    let tunnelId: string | null = null;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Tunnel connection timed out'));
    }, 15_000);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Backend sends { type: "ready", tunnel_id: "tun-xxx" } on successful connect
        if (msg.type === 'ready' && msg.tunnel_id) {
          tunnelId = msg.tunnel_id;

          // Advertise our Chrome's CDP URL so the backend worker can use it
          ws.send(
            JSON.stringify({
              type: 'cdp_ready',
              cdp_url: cdpUrl,
            }),
          );

          clearTimeout(timeout);
          resolve({
            tunnelId: tunnelId!,
            close: () => {
              try {
                ws.close();
              } catch {
                /* already closed */
              }
            },
          });
        }

        // Respond to heartbeat pings
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Tunnel connection failed: ${err.message}`));
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!tunnelId) {
        reject(new Error('Tunnel closed before connection was established'));
      }
    });
  });
}
