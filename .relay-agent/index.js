import http from 'http';
import https from 'https';
import WebSocket from 'ws';

// src/infrastructure/tunnel/relay/frame.ts
var MAGIC = Buffer.from([84, 82, 69, 76]);
var VERSION = 1;
var HEADER_SIZE = 15;
var CONTROL_CHANNEL = 0;
var FLAG_FIN = 1;
var FrameType = /* @__PURE__ */ ((FrameType2) => {
  FrameType2[FrameType2["CONTROL"] = 1] = "CONTROL";
  FrameType2[FrameType2["DATA"] = 2] = "DATA";
  FrameType2[FrameType2["STREAM"] = 3] = "STREAM";
  FrameType2[FrameType2["CLOSE"] = 4] = "CLOSE";
  return FrameType2;
})(FrameType || {});
var ControlOp = /* @__PURE__ */ ((ControlOp2) => {
  ControlOp2["HELLO"] = "hello";
  ControlOp2["HELLO_ACK"] = "hello_ack";
  ControlOp2["RESUME"] = "resume";
  ControlOp2["RESUME_ACK"] = "resume_ack";
  ControlOp2["SESSION_URL"] = "session_url";
  ControlOp2["REGISTER_DEVICE_ENDPOINT"] = "register_device_endpoint";
  ControlOp2["DEVICE_ENDPOINT_REGISTERED"] = "device_endpoint_registered";
  ControlOp2["HTTP_REQUEST"] = "http_request";
  ControlOp2["HTTP_RESPONSE"] = "http_response";
  ControlOp2["CHANNEL_OPEN"] = "channel_open";
  ControlOp2["HOT_RELOAD"] = "hot_reload";
  ControlOp2["HOT_RESTART"] = "hot_restart";
  ControlOp2["REBUILD"] = "rebuild";
  ControlOp2["REBUILD_DONE"] = "rebuild_done";
  ControlOp2["PING"] = "ping";
  ControlOp2["PONG"] = "pong";
  ControlOp2["CLOSE"] = "close";
  ControlOp2["ERROR"] = "error";
  return ControlOp2;
})(ControlOp || {});
function encodeFrame(frame) {
  if (frame.payload.length > 4294967295) {
    throw new Error("frame payload exceeds 4 GiB");
  }
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header[5] = frame.frameType;
  header[6] = frame.flags;
  header.writeUInt32BE(frame.channelId, 7);
  header.writeUInt32BE(frame.payload.length, 11);
  return Buffer.concat([header, frame.payload]);
}
function controlPayload(op, data) {
  const payload = { op };
  if (data) {
    Object.assign(payload, data);
  }
  return Buffer.from(JSON.stringify(payload));
}
function encodeControl(op, data, channelId = CONTROL_CHANNEL) {
  return encodeFrame({
    frameType: 1 /* CONTROL */,
    channelId,
    payload: controlPayload(op, data),
    flags: 0
  });
}
function parseControl(payload) {
  return JSON.parse(payload.toString("utf-8"));
}
function decodeFrame(data) {
  const parsed = tryParseFrame(data);
  if (!parsed.frame) {
    throw new Error("incomplete frame buffer");
  }
  if (parsed.rest.length > 0) {
    throw new Error("trailing bytes after frame");
  }
  return parsed.frame;
}
function tryParseFrame(buffer) {
  if (buffer.length < HEADER_SIZE) {
    return { frame: null, rest: buffer };
  }
  if (!buffer.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`bad frame magic: ${buffer.subarray(0, 4).toString("hex")}`);
  }
  const version = buffer[4];
  if (version !== VERSION) {
    throw new Error(`unsupported frame version: ${version}`);
  }
  const frameTypeValue = buffer[5];
  if (!(frameTypeValue in FrameType)) {
    throw new Error(`unknown frame type: ${frameTypeValue}`);
  }
  const flags = buffer[6];
  const channelId = buffer.readUInt32BE(7);
  const length = buffer.readUInt32BE(11);
  if (buffer.length < HEADER_SIZE + length) {
    return { frame: null, rest: buffer };
  }
  return {
    frame: {
      frameType: frameTypeValue,
      channelId,
      payload: buffer.subarray(HEADER_SIZE, HEADER_SIZE + length),
      flags
    },
    rest: buffer.subarray(HEADER_SIZE + length)
  };
}
var PING_INTERVAL_MS = 3e4;
var HTTP_PROXY_TIMEOUT_MS = 3e5;
var MAX_RECONNECT_DELAY_MS = 3e4;
var TARGET_PORT_HEADER = "x-relay-target-port";
var DEFAULT_ALLOWED_TARGET_PORTS = /* @__PURE__ */ new Set([4723]);
var RelayAgentClient = class {
  options;
  ws = null;
  buffer = Buffer.alloc(0);
  ready = false;
  stopped = false;
  reconnectAttempt = 0;
  pingTimer = null;
  reconnectTimer = null;
  /** True while a (re)connect socket attempt is in flight — blocks new attempts. */
  connecting = false;
  readyWaiters = [];
  bridges = /* @__PURE__ */ new Map();
  bridgePending = /* @__PURE__ */ new Map();
  bridgeUrls = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
  }
  /** Open the agent WebSocket, complete the hello handshake, and start keepalives. */
  async connect() {
    this.stopped = false;
    await this.openSocket();
    await this.waitForReady();
    this.startPing();
  }
  /** Gracefully close: tell the backend we're leaving, close sockets and bridges. */
  async stop() {
    this.stopped = true;
    this.clearPing();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.sendBytes(encodeControl("close" /* CLOSE */, { reason: "client_stopped" }));
    } catch {
    }
    this.ws?.close();
    for (const bridge of this.bridges.values()) {
      try {
        bridge.close();
      } catch {
      }
    }
    this.bridges.clear();
    this.bridgePending.clear();
    this.flushReadyWaiters(new Error("relay client stopped before the handshake completed"));
  }
  // ── Connection lifecycle ────────────────────────────────────────────
  wsUrl() {
    const base = this.options.apiUrl.replace(/^http/, "ws");
    const params = new URLSearchParams({
      token: this.options.authToken,
      session_id: this.options.sessionId
    });
    return `${base}/relay/agent/connect?${params.toString()}`;
  }
  openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl(), {
        perMessageDeflate: false,
        handshakeTimeout: 15e3
      });
      this.ws = ws;
      let opened = false;
      ws.once("open", () => {
        opened = true;
        resolve();
      });
      ws.once("error", (err) => {
        if (!opened) {
          reject(new Error(`Relay connection failed: ${err.message}`));
        }
      });
      ws.on("message", (data) => {
        this.onMessage(data);
      });
      ws.on("close", () => {
        this.onSocketClosed();
      });
      ws.on("error", (err) => {
        this.log("warn", `Relay socket error: ${err.message}`);
      });
    });
  }
  onSocketClosed() {
    const wasReady = this.ready;
    this.ready = false;
    this.connecting = false;
    if (this.stopped) {
      return;
    }
    if (!wasReady) {
      this.flushReadyWaiters(new Error("relay connection closed before the handshake"));
      this.scheduleReconnect(1e3);
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
  scheduleReconnect(delayOverrideMs) {
    if (this.stopped) {
      return;
    }
    if (this.reconnectTimer !== null || this.connecting) {
      return;
    }
    const delay = Math.min(
      delayOverrideMs ?? 1e3 * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt += 1;
    this.log("warn", `Relay dropped \u2014 reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) {
        return;
      }
      this.connecting = true;
      void this.openSocket().then(() => {
        this.connecting = false;
        if (this.stopped) {
          return;
        }
        this.sendHello();
      }).catch((err) => {
        this.connecting = false;
        this.log("warn", `Reconnect failed: ${err.message} \u2014 retrying`);
        this.scheduleReconnect(1e3);
      });
    }, delay);
  }
  waitForReady() {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }
  flushReadyWaiters(err) {
    while (this.readyWaiters.length > 0) {
      const waiter = this.readyWaiters.shift();
      waiter.reject(err);
    }
  }
  startPing() {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendBytes(encodeControl("ping" /* PING */));
      }
    }, PING_INTERVAL_MS);
  }
  clearPing() {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
  // ── Inbound frames ──────────────────────────────────────────────────
  onMessage(data) {
    const chunk = toBuffer(data);
    if (this.buffer.length === 0 && chunk.length > 0 && chunk[0] !== void 0 && chunk[0] !== 84) {
      const text = chunk.toString("utf-8").trim();
      try {
        const parsed = JSON.parse(text);
        if (parsed["type"] === "error") {
          this.log("warn", `Backend error: ${String(parsed["message"] ?? "unknown")}`);
          void this.stop();
          return;
        }
      } catch {
      }
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      let parsed;
      try {
        parsed = tryParseFrame(this.buffer);
      } catch (err) {
        this.log("warn", `Dropping malformed relay frame: ${String(err)}`);
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
  handleFrame(frame) {
    if (frame.frameType === 1 /* CONTROL */) {
      const data = parseControl(frame.payload);
      const op = data["op"];
      if (op === "hello_ack" /* HELLO_ACK */) {
        this.handleHelloAck(data);
      } else if (op === "http_request" /* HTTP_REQUEST */) {
        void this.handleHttpRequest(data);
      } else if (op === "ping" /* PING */) {
        this.sendBytes(encodeControl("pong" /* PONG */));
      } else if (op === "channel_open" /* CHANNEL_OPEN */) {
        this.handleChannelOpen(data);
      } else if (op === "close" /* CLOSE */) {
        this.onClosedByPeer(String(data["reason"] ?? "session closed by backend"));
      } else if (op === "error" /* ERROR */) {
        this.log("warn", `Relay error: ${String(data["message"] ?? "unknown")}`);
      }
      return;
    }
    if (frame.frameType === 2 /* DATA */ || frame.frameType === 3 /* STREAM */) {
      this.onChannelData(frame);
      return;
    }
    if (frame.frameType === 4 /* CLOSE */) {
      if (frame.channelId === CONTROL_CHANNEL) {
        this.onClosedByPeer("session closed by backend");
        return;
      }
      const bridge = this.bridges.get(frame.channelId);
      if (bridge !== void 0) {
        try {
          bridge.close();
        } catch {
        }
        this.bridges.delete(frame.channelId);
      }
    }
  }
  handleHelloAck(data) {
    const firstAck = !this.ready;
    this.ready = true;
    this.reconnectAttempt = 0;
    while (this.readyWaiters.length > 0) {
      const waiter = this.readyWaiters.shift();
      waiter.resolve();
    }
    if (!firstAck) {
      return;
    }
    this.options.onReady?.({
      sessionId: String(data["session_id"] ?? this.options.sessionId),
      code: data["code"] !== void 0 ? String(data["code"]) : void 0,
      status: data["status"] !== void 0 ? String(data["status"]) : void 0,
      framework: data["framework"] !== void 0 ? String(data["framework"]) : void 0
    });
  }
  onClosedByPeer(reason) {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearPing();
    try {
      this.ws?.close();
    } catch {
    }
    this.options.onClosed?.(reason);
  }
  // ── HTTP proxying ───────────────────────────────────────────────────
  async handleHttpRequest(data) {
    const requestId = String(data["request_id"] ?? "");
    if (!requestId) {
      return;
    }
    const method = String(data["method"] ?? "GET").toUpperCase();
    const path = String(data["path"] ?? "/");
    const query = String(data["query"] ?? "");
    const headers = data["headers"] ?? {};
    const body = Buffer.from(String(data["body"] ?? ""), "base64");
    const allowedTargetPorts = this.options.allowedTargetPorts ?? DEFAULT_ALLOWED_TARGET_PORTS;
    const targetPortEntry = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === TARGET_PORT_HEADER
    );
    const targetPortRaw = targetPortEntry?.[1];
    if (targetPortRaw !== void 0) {
      const targetPort = Number(targetPortRaw);
      if (!Number.isInteger(targetPort) || !allowedTargetPorts.has(targetPort)) {
        this.log("warn", `Relay HTTP target port ${targetPortRaw} not allowlisted`);
        this.sendBytes(
          encodeControl("http_response" /* HTTP_RESPONSE */, {
            request_id: requestId,
            status: 403,
            headers: { "content-type": "text/plain" },
            body: Buffer.from(`relay: target port ${targetPortRaw} is not allowlisted`).toString(
              "base64"
            )
          })
        );
        return;
      }
      this.log("debug", `Relay HTTP ${method} ${path} \u2192 localhost:${targetPort}`);
    }
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== TARGET_PORT_HEADER) {
        forwardHeaders[key] = value;
      }
    }
    const base = targetPortRaw !== void 0 ? `http://localhost:${targetPortRaw}` : this.options.localUrl;
    const url = new URL(base + path + (query ? `?${query}` : ""));
    const hasBody = method !== "GET" && method !== "HEAD";
    this.log("debug", `Relay HTTP ${method} ${path}${query ? `?${query}` : ""}`);
    try {
      const res = await this.httpRequest(url, method, forwardHeaders, hasBody ? body : void 0);
      this.sendBytes(
        encodeControl("http_response" /* HTTP_RESPONSE */, {
          request_id: requestId,
          status: res.status,
          headers: res.headers,
          body: res.body.toString("base64")
        })
      );
    } catch (err) {
      this.log("warn", `Relay HTTP proxy failed for ${path}: ${String(err)}`);
      this.sendBytes(
        encodeControl("http_response" /* HTTP_RESPONSE */, {
          request_id: requestId,
          status: 502,
          headers: { "content-type": "text/plain" },
          body: Buffer.from(`relay: ${err instanceof Error ? err.message : String(err)}`).toString(
            "base64"
          )
        })
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
  httpRequest(url, method, headers, body) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(url, { method, headers }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const responseHeaders = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== void 0) {
              responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
            }
          }
          resolve({
            status: res.statusCode ?? 502,
            headers: responseHeaders,
            body: Buffer.concat(chunks)
          });
        });
      });
      req.setTimeout(HTTP_PROXY_TIMEOUT_MS, () => {
        req.destroy(new Error("relay proxy timed out"));
      });
      req.on("error", reject);
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
  handleChannelOpen(data) {
    const channelId = Number(data["channel"] ?? 0);
    if (channelId <= 0 || !Number.isInteger(channelId)) {
      return;
    }
    const rawPath = String(data["path"] ?? "/");
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    const query = String(data["query"] ?? "");
    const base = this.options.localWsUrl ?? this.options.localUrl.replace(/^http/, "ws");
    const url = base + path + (query ? `?${query}` : "");
    this.bridgeUrls.set(channelId, url);
    this.ensureBridge(channelId, url);
  }
  onChannelData(frame) {
    if (frame.channelId === CONTROL_CHANNEL) {
      return;
    }
    const channelId = frame.channelId;
    let bridge = this.bridges.get(channelId);
    if (bridge === void 0) {
      const url = this.bridgeUrls.get(channelId) ?? this.options.localWsUrl ?? this.options.localUrl.replace(/^http/, "ws");
      bridge = this.ensureBridge(channelId, url);
    }
    if (bridge.readyState === WebSocket.OPEN) {
      bridge.send(toBridgePayload(frame.payload));
    } else {
      this.bridgePending.get(channelId)?.push(frame.payload);
    }
  }
  ensureBridge(channelId, url) {
    const existing = this.bridges.get(channelId);
    if (existing !== void 0) {
      return existing;
    }
    const bridge = new WebSocket(url, { perMessageDeflate: false });
    this.bridges.set(channelId, bridge);
    this.bridgePending.set(channelId, []);
    bridge.on("open", () => {
      const pending = this.bridgePending.get(channelId) ?? [];
      this.bridgePending.delete(channelId);
      for (const payload of pending) {
        bridge?.send(toBridgePayload(payload));
      }
    });
    bridge.on("message", (data) => {
      this.sendBytes(
        encodeFrame({
          frameType: 2 /* DATA */,
          channelId,
          payload: toBuffer(data),
          flags: 0
        })
      );
    });
    bridge.on("close", () => {
      this.bridges.delete(channelId);
      this.bridgePending.delete(channelId);
      this.sendBytes(
        encodeFrame({
          frameType: 4 /* CLOSE */,
          channelId,
          payload: Buffer.alloc(0),
          flags: 0
        })
      );
    });
    bridge.on("error", () => {
      try {
        bridge?.close();
      } catch {
      }
    });
    return bridge;
  }
  // ── Sending ─────────────────────────────────────────────────────────
  sendHello() {
    this.sendBytes(encodeControl("hello" /* HELLO */, { session_id: this.options.sessionId }));
  }
  sendBytes(raw) {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(raw);
  }
  log(level, message) {
    if (level === "debug") {
      this.options.logger?.debug(message);
    } else {
      this.options.logger?.warn(message);
    }
  }
};
var _textDecoder = new TextDecoder("utf-8", { fatal: true });
function toBridgePayload(payload) {
  try {
    return _textDecoder.decode(payload);
  } catch {
    return payload;
  }
}
function toBuffer(data) {
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

export { CONTROL_CHANNEL, ControlOp, FLAG_FIN, FrameType, HEADER_SIZE, MAGIC, RelayAgentClient, VERSION, controlPayload, decodeFrame, encodeControl, encodeFrame, parseControl, tryParseFrame };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map