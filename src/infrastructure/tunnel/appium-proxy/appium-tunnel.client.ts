/**
 * Appium tunnel client — dials out to the backend's /appium-tunnel/connect and holds
 * the line open for the whole test run, replaying proxied requests against local
 * Appium and streaming responses back.
 *
 * Unlike tunnel.client.ts (one-shot CDP handshake, no reconnect needed), this needs
 * to survive network blips for the duration of a test, so it adds real
 * reconnect-with-backoff — the closest existing precedent is socket.io-client's
 * built-in `reconnection` config used in appium.bridge.ts; this is the same idea,
 * hand-rolled since raw `ws` has no built-in retry.
 */

import http from 'http';
import WebSocket from 'ws';
import {
  type Frame,
  type PongFrame,
  type RequestFrame,
  type ResponseFrame,
  parseFrame,
  stripHopByHop,
} from './frame.js';

export interface AppiumTunnelOptions {
  apiBaseUrl: string;
  authToken: string;
  workspaceId: string;
  appiumUrl?: string;
  onReconnecting?: (attempt: number, delayMs: number) => void;
}

export interface AppiumTunnelHandle {
  close: () => void;
}

const CONNECT_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_FACTOR = 2;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER = 0.3;

function buildWsUrl(apiBaseUrl: string, authToken: string, workspaceId: string): string {
  const wsBase = apiBaseUrl.replace(/^http/, 'ws');
  const params = new URLSearchParams({ token: authToken, workspace_id: workspaceId });
  return `${wsBase}/appium-tunnel/connect?${params.toString()}`;
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

/** Replays one proxied request against local Appium via the low-level `http` module
 * (same approach as appium.bridge.ts's fetchJson, generalized to arbitrary
 * method/path/headers/body instead of fixed JSON commands). Never throws — an
 * unreachable local Appium becomes a 502 response frame, not a crashed tunnel. */
function replayLocally(appiumUrl: string, frame: RequestFrame): Promise<ResponseFrame> {
  return new Promise((resolve) => {
    const target = new URL(frame.path, appiumUrl);
    const body = frame.body_b64 ? Buffer.from(frame.body_b64, 'base64') : undefined;

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: frame.method,
        headers: stripHopByHop(frame.headers),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            type: 'response',
            id: frame.id,
            status: res.statusCode ?? 502,
            headers: flattenHeaders(res.headers),
            body_b64: bodyBuffer.length ? bodyBuffer.toString('base64') : null,
            error: null,
          });
        });
      },
    );

    req.on('error', (err: Error) => {
      resolve({
        type: 'response',
        id: frame.id,
        status: 502,
        headers: {},
        body_b64: null,
        error: err.message,
      });
    });

    if (body) req.write(body);
    req.end();
  });
}

export async function connectAppiumTunnel(opts: AppiumTunnelOptions): Promise<AppiumTunnelHandle> {
  const appiumUrl = opts.appiumUrl ?? 'http://localhost:4723';
  const wsUrl = buildWsUrl(opts.apiBaseUrl, opts.authToken, opts.workspaceId);

  let stopped = false;
  let currentWs: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  function handleFrame(ws: WebSocket, raw: WebSocket.RawData): void {
    let frame: Frame;
    try {
      frame = parseFrame(raw.toString());
    } catch {
      return; // drop unparseable frames, matching the backend's own tolerance
    }

    if (frame.type === 'ping') {
      const pong: PongFrame = { type: 'pong', id: frame.id, ts: Date.now() / 1000 };
      ws.send(JSON.stringify(pong));
      return;
    }

    if (frame.type === 'request') {
      // Task-per-frame: don't await, so a slow Appium call never blocks
      // concurrently-arriving requests or pings.
      void replayLocally(appiumUrl, frame).then((response) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }
      });
    }
  }

  /** Wires the steady-state handlers onto an already-open socket: dispatch inbound
   * frames, and reconnect (with backoff) on close, until close() is called. */
  function attachSteadyState(ws: WebSocket): void {
    ws.on('message', (data) => handleFrame(ws, data));
    ws.on('close', () => {
      if (currentWs === ws) currentWs = null;
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** attempt, BACKOFF_MAX_MS);
    const delayWithJitter = Math.round(delay + Math.random() * BACKOFF_JITTER * delay);
    attempt += 1;
    opts.onReconnecting?.(attempt, delayWithJitter);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      const ws = new WebSocket(wsUrl);
      currentWs = ws;
      ws.on('open', () => {
        attempt = 0; // clean connect -- reset backoff so it doesn't escalate across sessions
      });
      ws.on('error', () => {
        // 'close' always follows 'error' for ws -- reconnect is scheduled there.
      });
      attachSteadyState(ws);
    }, delayWithJitter);
  }

  // Initial connect: resolve/reject so the caller gets a real error if the very
  // first attempt fails (e.g. bad token) instead of silently retrying forever.
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    currentWs = ws;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Appium tunnel connection timed out'));
    }, CONNECT_TIMEOUT_MS);

    ws.once('open', () => {
      clearTimeout(timeout);
      attachSteadyState(ws);
      resolve();
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`Appium tunnel connection failed: ${err.message}`));
    });
  });

  return {
    close: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      currentWs?.close();
      currentWs = null;
    },
  };
}
