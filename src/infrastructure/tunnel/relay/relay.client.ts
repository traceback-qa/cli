/**
 * RelayAgentClient — the CLI half of the relay tunnel.
 *
 * One long-lived WebSocket to `ws(s)://<api>/relay/agent/connect?token=...&session_id=...`
 * where the attached backend broker hands this process every HTTP request and device
 * WebSocket that arrives on the session's public URL. The client:
 *
 *   1. completes the hello handshake (backend answers with `hello_ack`),
 *   2. proxies every `http_request` control frame to the local dev server and answers
 *      with an `http_response` frame (or to a local allowlisted port when the request
 *      carries an `x-relay-target-port` header — how the cloud drives the user's
 *      local Appium server through the tunnel),
 *   3. bridges device-originated WebSockets (`DATA` frames on channels >= 1) to a
 *      local WebSocket endpoint (Metro's HMR socket, devtools, ...),
 *   4. pings on an interval to keep the connection alive, and auto-reconnects with
 *      backoff after an unexpected drop (the backend resumes the session on reconnect).
 *
 * Wire contract lives in `frame.ts` — the lockstep mirror of the backend's
 * `src/contexts/relay/domain/frame.py`.
 */

import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import {
  CONTROL_CHANNEL,
  ControlOp,
  type Frame,
  FrameType,
  encodeControl,
  encodeFrame,
  parseControl,
  tryParseFrame,
} from './frame.js';

export interface RelayHttpRequest {
  requestId: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface RelayReadyInfo {
  sessionId: string;
  code?: string;
  status?: string;
  framework?: string;
}

export interface RelayRebuildRequest {
  /** Correlates this rebuild with the agent's rebuild_done answer. */
  requestId: string;
  /** ios | kotlin | native */
  framework: string;
  /** Human-readable reason for the rebuild (often empty). */
  message: string;
}

export interface RelayRebuildResult {
  /** 'built' | 'failed' */
  status: string;
  framework: string;
  message: string;
  startedAt: string;
  durationMs?: number;
}

export interface RelayClientLogger {
  debug: (message: string) => void;
  warn: (message: string) => void;
}

export interface RelayAgentClientOptions {
  /** Backend API origin, e.g. http://localhost:8000 (no /api/v1 suffix). */
  apiUrl: string;
  /** CLI auth token — a tb_live_ API key (same credential the REST calls use). */
  authToken: string;
  /** Session ID this agent attaches to (must be owned by the token's user). */
  sessionId: string;
  /** Local dev server the tunnel forwards HTTP traffic to. */
  localUrl: string;
  /**
   * Base origin for bridged device WebSockets, e.g. `ws://localhost:8081` (no path).
   * The backend announces each device channel's original path (`/hot`, `/message`, ...)
   * via a `channel_open` control frame, and the agent bridges that channel to
   * `localWsUrl + path`. Kept as a fallback (full URL) when no `channel_open` arrives.
   */
  localWsUrl?: string;
  /**
   * Local ports the tunnel may forward `x-relay-target-port`-tagged HTTP to.
   * Defaults to the standard set (Appium 4723). Tests override this to avoid
   * binding real Appium ports.
   */
  allowedTargetPorts?: Set<number>;
  logger?: RelayClientLogger;
  onReady?: (info: RelayReadyInfo) => void;
  onClosed?: (reason: string) => void;
  /**
   * Called when the backend asks this agent to rebuild the native app (cloud-
   * initiated live update). Implementations run the build and return the result;
   * the client answers with a `rebuild_done` frame automatically.
   */
  onRebuildRequest?: (request: RelayRebuildRequest) => Promise<RelayRebuildResult>;
  /** Whether to auto-reconnect after an established connection drops (default true). */
  reconnect?: boolean;
}

const PING_INTERVAL_MS = 30_000;
// Must be >= the backend's `relay.http_proxy_timeout_seconds` (300s default): a
// slow-but-legitimate upstream — e.g. iOS XCUITest session creation, which builds
// + installs WebDriverAgent on the Simulator on first run — can take minutes to
// answer. A shorter courier timeout would kill the request before the backend's own
// ceiling and surface as a bogus 502 instead of the real (slow) result.
const HTTP_PROXY_TIMEOUT_MS = 300_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Header the backend sets on relayed HTTP requests that must reach a specific
 * LOCAL port on this machine instead of the default dev-server target. The cloud
 * engine sets it when driving the user's Appium through the tunnel.
 */
const TARGET_PORT_HEADER = 'x-relay-target-port';

/**
 * Local ports the tunnel is allowed to forward HTTP to. Appium (Android) is 4723;
 * iOS Simulator Appium is 4724 and can be added when iOS lands. Everything else
 * goes to the configured dev-server URL as before. Overridable per-client (e.g. in
 * tests) via `allowedTargetPorts`.
 */
const DEFAULT_ALLOWED_TARGET_PORTS = new Set([4723]);

interface ReadyWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class RelayAgentClient {
  private readonly options: RelayAgentClientOptions;
  private ws: WebSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private ready = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** True while a (re)connect socket attempt is in flight — blocks new attempts. */
  private connecting = false;
  private readonly readyWaiters: ReadyWaiter[] = [];
  private readonly bridges = new Map<number, WebSocket>();
  private readonly bridgePending = new Map<number, Buffer[]>();
  private readonly bridgeUrls = new Map<number, string>();

  constructor(options: RelayAgentClientOptions) {
    this.options = options;
  }

  /** Open the agent WebSocket, complete the hello handshake, and start keepalives. */
  async connect(): Promise<void> {
    this.stopped = false;
    await this.openSocket();
    await this.waitForReady();
    this.startPing();
  }

  /** Gracefully close: tell the backend we're leaving, close sockets and bridges. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.sendBytes(encodeControl(ControlOp.CLOSE, { reason: 'client_stopped' }));
    } catch {
      /* socket already gone */
    }
    this.ws?.close();
    for (const bridge of this.bridges.values()) {
      try {
        bridge.close();
      } catch {
        /* already closed */
      }
    }
    this.bridges.clear();
    this.bridgePending.clear();
    this.flushReadyWaiters(new Error('relay client stopped before the handshake completed'));
  }

  // ── Connection lifecycle ────────────────────────────────────────────

  private wsUrl(): string {
    const base = this.options.apiUrl.replace(/^http/, 'ws');
    const params = new URLSearchParams({
      token: this.options.authToken,
      session_id: this.options.sessionId,
    });
    return `${base}/relay/agent/connect?${params.toString()}`;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      // handshakeTimeout: a socket stuck in CONNECTING (TCP accepted, WS upgrade never
      // completes) would otherwise leave `connecting` true forever and permanently wedge
      // the single-flight reconnect guard — 15s and the attempt fails cleanly instead.
      const ws = new WebSocket(this.wsUrl(), {
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
      });
      this.ws = ws;
      let opened = false;

      ws.once('open', () => {
        opened = true;
        resolve();
      });
      ws.once('error', (err) => {
        if (!opened) {
          reject(new Error(`Relay connection failed: ${err.message}`));
        }
      });
      ws.on('message', (data) => {
        this.onMessage(data);
      });
      ws.on('close', () => {
        this.onSocketClosed();
      });
      ws.on('error', (err) => {
        this.log('warn', `Relay socket error: ${err.message}`);
      });
    });
  }

  private onSocketClosed(): void {
    const wasReady = this.ready;
    this.ready = false;
    // The socket that closed is no longer an in-flight attempt, whatever stage it
    // died at (pre-open, open, or established) — otherwise a dead attempt could
    // block the single-flight guard forever.
    this.connecting = false;
    if (this.stopped) {
      return;
    }
    if (!wasReady) {
      this.flushReadyWaiters(new Error('relay connection closed before the handshake'));
      // A drop before the handshake still counts as a disconnect: schedule a
      // reconnect so a backend restart that lands mid-handshake can't strand
      // the tunnel (no hello_ack would ever have reset the backoff).
      this.scheduleReconnect(1000);
      return;
    }
    const reconnect = this.options.reconnect ?? true;
    if (!reconnect) {
      return;
    }
    this.scheduleReconnect();
  }

  /**
   * (Re)connect with exponential backoff, retrying forever. A failed attempt
   * schedules the next one — the tunnel must outlive transient backend restarts
   * (the backend resumes the session on reconnect).
   */
  private scheduleReconnect(delayOverrideMs?: number): void {
    if (this.stopped) {
      return;
    }
    // Single-flight: a pending timer OR an in-flight socket attempt means a
    // reconnect is already scheduled — never stack a second one. (A failed attempt
    // fires both an `error` and a `close` event; without this guard each would
    // schedule its own timer and the tunnel would fan out into a reconnect storm,
    // dropping every in-flight HTTP request as connections churn.)
    if (this.reconnectTimer !== null || this.connecting) {
      return;
    }
    const delay = Math.min(
      delayOverrideMs ?? 1000 * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.log('warn', `Relay dropped — reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) {
        return;
      }
      this.connecting = true;
      void this.openSocket()
        .then(() => {
          this.connecting = false;
          if (this.stopped) {
            return; // stop() raced the connect — don't resurrect a socket the user closed
          }
          this.sendHello();
        })
        .catch((err: Error) => {
          this.connecting = false;
          this.log('warn', `Reconnect failed: ${err.message} — retrying`);
          this.scheduleReconnect(1000);
        });
    }, delay);
  }

  private waitForReady(): Promise<void> {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  private flushReadyWaiters(err: Error): void {
    while (this.readyWaiters.length > 0) {
      const waiter = this.readyWaiters.shift()!;
      waiter.reject(err);
    }
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendBytes(encodeControl(ControlOp.PING));
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── Inbound frames ──────────────────────────────────────────────────

  private onMessage(data: WebSocket.RawData): void {
    const chunk = toBuffer(data);

    // The backend may send a plain-JSON error envelope (not a frame) before closing
    // with a protocol code — surface it instead of misparsing it as a frame.
    if (
      this.buffer.length === 0 &&
      chunk.length > 0 &&
      chunk[0] !== undefined &&
      chunk[0] !== 0x54 // 'T'
    ) {
      const text = chunk.toString('utf-8').trim();
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed['type'] === 'error') {
          this.log('warn', `Backend error: ${String(parsed['message'] ?? 'unknown')}`);
          void this.stop();
          return;
        }
      } catch {
        /* not JSON — not a valid frame start; drop it */
      }
      return;
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      let parsed;
      try {
        parsed = tryParseFrame(this.buffer);
      } catch (err) {
        // Unparseable bytes mean protocol corruption: drop and resync, don't kill the
        // tunnel (mirrors the backend broker's posture).
        this.log('warn', `Dropping malformed relay frame: ${String(err)}`);
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (!parsed.frame) {
        break;
      }
      this.buffer = parsed.rest;
      this.handleFrame(parsed.frame);
    }
  }

  private handleFrame(frame: Frame): void {
    if (frame.frameType === FrameType.CONTROL) {
      const data = parseControl(frame.payload);
      const op = data['op'];
      if (op === ControlOp.HELLO_ACK) {
        this.handleHelloAck(data);
      } else if (op === ControlOp.HTTP_REQUEST) {
        void this.handleHttpRequest(data);
      } else if (op === ControlOp.PING) {
        this.sendBytes(encodeControl(ControlOp.PONG));
      } else if (op === ControlOp.CHANNEL_OPEN) {
        this.handleChannelOpen(data);
      } else if (op === ControlOp.REBUILD) {
        void this.handleRebuildRequest(data);
      } else if (op === ControlOp.CLOSE) {
        this.onClosedByPeer(String(data['reason'] ?? 'session closed by backend'));
      } else if (op === ControlOp.ERROR) {
        this.log('warn', `Relay error: ${String(data['message'] ?? 'unknown')}`);
      }
      // RESUME_ACK / PONG / device ops (hot_reload, hot_restart) need no action
      // from the plain HTTP/WS agent yet — native rebuild is handled above.
      return;
    }

    if (frame.frameType === FrameType.DATA || frame.frameType === FrameType.STREAM) {
      this.onChannelData(frame);
      return;
    }

    if (frame.frameType === FrameType.CLOSE) {
      if (frame.channelId === CONTROL_CHANNEL) {
        this.onClosedByPeer('session closed by backend');
        return;
      }
      const bridge = this.bridges.get(frame.channelId);
      if (bridge !== undefined) {
        try {
          bridge.close();
        } catch {
          /* already closed */
        }
        this.bridges.delete(frame.channelId);
      }
    }
  }

  // ── Native rebuild ────────────────────────────────────────────────

  /**
   * The backend asked this machine to rebuild/reinstall/relaunch the native app
   * (cloud-initiated live update). Run the registered handler and answer with a
   * `rebuild_done` frame so the caller (and the session row) gets the result.
   */
  private async handleRebuildRequest(data: Record<string, unknown>): Promise<void> {
    const requestId = String(data['request_id'] ?? '');
    const framework = String(data['framework'] ?? 'native');
    const message = String(data['message'] ?? '');
    const startedAt = new Date().toISOString();

    if (!this.options.onRebuildRequest) {
      this.sendBytes(
        encodeControl(ControlOp.REBUILD_DONE, {
          request_id: requestId,
          status: 'failed',
          framework,
          message: 'no rebuild handler registered on this agent',
          started_at: startedAt,
        }),
      );
      return;
    }

    try {
      const result = await this.options.onRebuildRequest({ requestId, framework, message });
      this.sendBytes(
        encodeControl(ControlOp.REBUILD_DONE, {
          request_id: requestId,
          status: result.status,
          framework: result.framework,
          message: result.message,
          started_at: result.startedAt,
          duration_ms: result.durationMs,
        }),
      );
    } catch (err) {
      this.log('warn', `Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
      this.sendBytes(
        encodeControl(ControlOp.REBUILD_DONE, {
          request_id: requestId,
          status: 'failed',
          framework,
          message: err instanceof Error ? err.message : String(err),
          started_at: startedAt,
        }),
      );
    }
  }

  /**
   * Report a locally-performed native rebuild to the backend (agent-initiated path:
   * `traceback tunnel rebuild`). The session row records it as the device's freshest
   * build, and any waiting `request_rebuild` resolves with it.
   */
  sendRebuildDone(result: RelayRebuildResult): void {
    this.sendBytes(
      encodeControl(ControlOp.REBUILD_DONE, {
        status: result.status,
        framework: result.framework,
        message: result.message,
        started_at: result.startedAt,
        duration_ms: result.durationMs,
      }),
    );
  }

  private handleHelloAck(data: Record<string, unknown>): void {
    const firstAck = !this.ready;
    this.ready = true;
    this.reconnectAttempt = 0;
    while (this.readyWaiters.length > 0) {
      const waiter = this.readyWaiters.shift()!;
      waiter.resolve();
    }
    if (!firstAck) {
      return;
    }
    this.options.onReady?.({
      sessionId: String(data['session_id'] ?? this.options.sessionId),
      code: data['code'] !== undefined ? String(data['code']) : undefined,
      status: data['status'] !== undefined ? String(data['status']) : undefined,
      framework: data['framework'] !== undefined ? String(data['framework']) : undefined,
    });
  }

  private onClosedByPeer(reason: string): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearPing();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.options.onClosed?.(reason);
  }

  // ── HTTP proxying ───────────────────────────────────────────────────

  private async handleHttpRequest(data: Record<string, unknown>): Promise<void> {
    const requestId = String(data['request_id'] ?? '');
    if (!requestId) {
      return;
    }
    const method = String(data['method'] ?? 'GET').toUpperCase();
    const path = String(data['path'] ?? '/');
    const query = String(data['query'] ?? '');
    const headers = (data['headers'] ?? {}) as Record<string, string>;
    const body = Buffer.from(String(data['body'] ?? ''), 'base64');

    // Route to a local allowlisted port when the backend tags the request (the
    // cloud engine driving the user's Appium) — otherwise the default dev server.
    const allowedTargetPorts = this.options.allowedTargetPorts ?? DEFAULT_ALLOWED_TARGET_PORTS;
    const targetPortEntry = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === TARGET_PORT_HEADER,
    );
    const targetPortRaw = targetPortEntry?.[1];
    if (targetPortRaw !== undefined) {
      const targetPort = Number(targetPortRaw);
      if (!Number.isInteger(targetPort) || !allowedTargetPorts.has(targetPort)) {
        this.log('warn', `Relay HTTP target port ${targetPortRaw} not allowlisted`);
        this.sendBytes(
          encodeControl(ControlOp.HTTP_RESPONSE, {
            request_id: requestId,
            status: 403,
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from(`relay: target port ${targetPortRaw} is not allowlisted`).toString(
              'base64',
            ),
          }),
        );
        return;
      }
      this.log('debug', `Relay HTTP ${method} ${path} → localhost:${targetPort}`);
    }

    // The target-port tag is our routing hint — never forward it to the local server.
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== TARGET_PORT_HEADER) {
        forwardHeaders[key] = value;
      }
    }

    const base =
      targetPortRaw !== undefined ? `http://localhost:${targetPortRaw}` : this.options.localUrl;
    const url = new URL(base + path + (query ? `?${query}` : ''));
    const hasBody = method !== 'GET' && method !== 'HEAD';

    this.log('debug', `Relay HTTP ${method} ${path}${query ? `?${query}` : ''}`);

    try {
      const res = await this.httpRequest(url, method, forwardHeaders, hasBody ? body : undefined);
      this.sendBytes(
        encodeControl(ControlOp.HTTP_RESPONSE, {
          request_id: requestId,
          status: res.status,
          headers: res.headers,
          body: res.body.toString('base64'),
        }),
      );
    } catch (err) {
      this.log('warn', `Relay HTTP proxy failed for ${path}: ${String(err)}`);
      this.sendBytes(
        encodeControl(ControlOp.HTTP_RESPONSE, {
          request_id: requestId,
          status: 502,
          headers: { 'content-type': 'text/plain' },
          body: Buffer.from(`relay: ${err instanceof Error ? err.message : String(err)}`).toString(
            'base64',
          ),
        }),
      );
    }
  }

  /**
   * Proxy one relayed request to the local dev server using node:http(s).request.
   *
   * Uses the raw http module (not fetch) because the relayed request may carry a
   * ``host`` header (the device's Host, forwarded by the backend) that must reach
   * Metro/Expo verbatim so they generate URLs pointing back at the tunnel origin -
   * fetch forbids overriding the Host header.
   */
  private httpRequest(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) {
              // Node may give set-cookie-style headers as arrays; collapse to one value.
              responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
            }
          }
          resolve({
            status: res.statusCode ?? 502,
            headers: responseHeaders,
            body: Buffer.concat(chunks),
          });
        });
      });
      req.setTimeout(HTTP_PROXY_TIMEOUT_MS, () => {
        req.destroy(new Error('relay proxy timed out'));
      });
      req.on('error', reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  // ── Device WebSocket channel bridging ───────────────────────────────

  /**
   * The backend announces each device WebSocket's original path (e.g. Metro's `/hot`
   * HMR socket) so the agent bridges the channel to the *same* local endpoint instead
   * of a fixed one. Arrives before the first DATA frame on the channel.
   */
  private handleChannelOpen(data: Record<string, unknown>): void {
    const channelId = Number(data['channel'] ?? 0);
    if (channelId <= 0 || !Number.isInteger(channelId)) {
      return;
    }
    const rawPath = String(data['path'] ?? '/');
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    const query = String(data['query'] ?? '');
    const base = this.options.localWsUrl ?? this.options.localUrl.replace(/^http/, 'ws');
    const url = base + path + (query ? `?${query}` : '');
    this.bridgeUrls.set(channelId, url);
    this.ensureBridge(channelId, url);
  }

  private onChannelData(frame: Frame): void {
    if (frame.channelId === CONTROL_CHANNEL) {
      return;
    }
    const channelId = frame.channelId;
    let bridge = this.bridges.get(channelId);
    if (bridge === undefined) {
      // Prefer the path announced by the backend; fall back to a fixed URL for
      // legacy backends that don't send channel_open.
      const url =
        this.bridgeUrls.get(channelId) ??
        this.options.localWsUrl ??
        this.options.localUrl.replace(/^http/, 'ws');
      bridge = this.ensureBridge(channelId, url);
    }
    if (bridge.readyState === WebSocket.OPEN) {
      // The Dart VM service (Flutter hot reload) rejects binary frames with close
      // code 4001 and only accepts text JSON, so send text frames when the payload
      // is valid UTF-8 (falling back to binary otherwise). Metro's HMR /hot socket
      // accepts both.
      bridge.send(toBridgePayload(frame.payload));
    } else {
      // Buffer until the bridge connects; never drop the first device message.
      this.bridgePending.get(channelId)?.push(frame.payload);
    }
  }

  private ensureBridge(channelId: number, url: string): WebSocket {
    const existing = this.bridges.get(channelId);
    if (existing !== undefined) {
      return existing;
    }
    const bridge = new WebSocket(url, { perMessageDeflate: false });
    this.bridges.set(channelId, bridge);
    this.bridgePending.set(channelId, []);

    bridge.on('open', () => {
      // Flush anything that arrived while the local endpoint was still connecting.
      const pending = this.bridgePending.get(channelId) ?? [];
      this.bridgePending.delete(channelId);
      for (const payload of pending) {
        bridge?.send(toBridgePayload(payload));
      }
    });
    bridge.on('message', (data) => {
      this.sendBytes(
        encodeFrame({
          frameType: FrameType.DATA,
          channelId,
          payload: toBuffer(data),
          flags: 0,
        }),
      );
    });
    bridge.on('close', () => {
      this.bridges.delete(channelId);
      this.bridgePending.delete(channelId);
      this.sendBytes(
        encodeFrame({
          frameType: FrameType.CLOSE,
          channelId,
          payload: Buffer.alloc(0),
          flags: 0,
        }),
      );
    });
    bridge.on('error', () => {
      try {
        bridge?.close();
      } catch {
        /* already closed */
      }
    });
    return bridge;
  }

  // ── Sending ─────────────────────────────────────────────────────────

  private sendHello(): void {
    this.sendBytes(encodeControl(ControlOp.HELLO, { session_id: this.options.sessionId }));
  }

  private sendBytes(raw: Buffer): void {
    // Late events (bridge teardown, timer pings) can fire after the socket started
    // closing — silently drop rather than throwing from inside an event handler.
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(raw);
  }

  private log(level: 'debug' | 'warn', message: string): void {
    if (level === 'debug') {
      this.options.logger?.debug(message);
    } else {
      this.options.logger?.warn(message);
    }
  }
}

const _textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Convert a relay DATA payload into a bridge frame. Text JSON (the Dart VM
 * service protocol) must arrive as text frames; anything not valid UTF-8 stays
 * binary.
 */
function toBridgePayload(payload: Buffer): string | Buffer {
  try {
    return _textDecoder.decode(payload);
  } catch {
    return payload;
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk)));
  }
  return Buffer.from(data);
}
