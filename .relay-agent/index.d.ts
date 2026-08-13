/**
 * Relay frame codec — the CLI mirror of `src/contexts/relay/domain/frame.py` in the
 * backend. The two MUST stay in lockstep: any change to the header layout, frame
 * types, or control ops has to land on both sides of the tunnel.
 *
 * Every WebSocket message in the relay is a single binary frame:
 *
 *   magic(4) version(1) frame_type(1) flags(1) channel_id(4 BE) length(4 BE) payload(...)
 *
 * = 15-byte header. Frame types:
 *
 *   CONTROL - JSON payload; control plane (hello, http_request/http_response, ping...).
 *   DATA    - opaque payload routed on a channel (device WebSocket bridging).
 *   STREAM  - raw TCP bytes routed on a channel (reserved for native/Flutter streams).
 *   CLOSE   - tears down the given channel (or the whole connection when channel == 0).
 */
/** Wire magic — the ASCII bytes "TREL". */
declare const MAGIC: Buffer<ArrayBuffer>;
declare const VERSION = 1;
declare const HEADER_SIZE = 15;
/** Channel 0 is reserved for the control plane; device channels start at 1. */
declare const CONTROL_CHANNEL = 0;
declare const FLAG_FIN = 1;
declare enum FrameType {
    CONTROL = 1,
    DATA = 2,
    STREAM = 3,
    CLOSE = 4
}
declare enum ControlOp {
    HELLO = "hello",
    HELLO_ACK = "hello_ack",
    RESUME = "resume",
    RESUME_ACK = "resume_ack",
    SESSION_URL = "session_url",
    REGISTER_DEVICE_ENDPOINT = "register_device_endpoint",
    DEVICE_ENDPOINT_REGISTERED = "device_endpoint_registered",
    HTTP_REQUEST = "http_request",
    HTTP_RESPONSE = "http_response",
    CHANNEL_OPEN = "channel_open",
    HOT_RELOAD = "hot_reload",
    HOT_RESTART = "hot_restart",
    REBUILD = "rebuild",
    REBUILD_DONE = "rebuild_done",
    PING = "ping",
    PONG = "pong",
    CLOSE = "close",
    ERROR = "error"
}
interface Frame {
    frameType: FrameType;
    channelId: number;
    payload: Buffer;
    flags: number;
}
/** Encode a frame to its full wire representation (header + payload). */
declare function encodeFrame(frame: Frame): Buffer;
/** Build the JSON payload of a CONTROL frame. */
declare function controlPayload(op: ControlOp | string, data?: Record<string, unknown>): Buffer;
/** Encode a CONTROL frame for the given op and optional JSON payload. */
declare function encodeControl(op: ControlOp | string, data?: Record<string, unknown>, channelId?: number): Buffer;
/** Decode a CONTROL frame payload into a plain object. */
declare function parseControl(payload: Buffer): Record<string, unknown>;
/** Parse exactly one frame from a buffer exactly `HEADER_SIZE + length` bytes long. */
declare function decodeFrame(data: Buffer): Frame;
interface TryParseResult {
    frame: Frame | null;
    rest: Buffer;
}
/**
 * Parse one frame from the head of `buffer`; returns the frame plus the remainder.
 *
 * Returns `{ frame: null, rest: buffer }` (the input unchanged) when the buffer
 * holds an incomplete frame, so callers can accumulate until a full frame arrives.
 * Throws when the head of the buffer is not a valid frame (bad magic, version, or
 * frame type).
 */
declare function tryParseFrame(buffer: Buffer): TryParseResult;

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
interface RelayHttpRequest {
    requestId: string;
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    body: Buffer;
}
interface RelayReadyInfo {
    sessionId: string;
    code?: string;
    status?: string;
    framework?: string;
}
interface RelayClientLogger {
    debug: (message: string) => void;
    warn: (message: string) => void;
}
interface RelayAgentClientOptions {
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
    /** Whether to auto-reconnect after an established connection drops (default true). */
    reconnect?: boolean;
}
declare class RelayAgentClient {
    private readonly options;
    private ws;
    private buffer;
    private ready;
    private stopped;
    private reconnectAttempt;
    private pingTimer;
    private reconnectTimer;
    /** True while a (re)connect socket attempt is in flight — blocks new attempts. */
    private connecting;
    private readonly readyWaiters;
    private readonly bridges;
    private readonly bridgePending;
    private readonly bridgeUrls;
    constructor(options: RelayAgentClientOptions);
    /** Open the agent WebSocket, complete the hello handshake, and start keepalives. */
    connect(): Promise<void>;
    /** Gracefully close: tell the backend we're leaving, close sockets and bridges. */
    stop(): Promise<void>;
    private wsUrl;
    private openSocket;
    private onSocketClosed;
    /**
     * (Re)connect with exponential backoff, retrying forever. A failed attempt
     * schedules the next one — the tunnel must outlive transient backend restarts
     * (the backend resumes the session on reconnect).
     */
    private scheduleReconnect;
    private waitForReady;
    private flushReadyWaiters;
    private startPing;
    private clearPing;
    private onMessage;
    private handleFrame;
    private handleHelloAck;
    private onClosedByPeer;
    private handleHttpRequest;
    /**
     * Proxy one relayed request to the local dev server using node:http(s).request.
     *
     * Uses the raw http module (not fetch) because the relayed request may carry a
     * ``host`` header (the device's Host, forwarded by the backend) that must reach
     * Metro/Expo verbatim so they generate URLs pointing back at the tunnel origin -
     * fetch forbids overriding the Host header.
     */
    private httpRequest;
    /**
     * The backend announces each device WebSocket's original path (e.g. Metro's `/hot`
     * HMR socket) so the agent bridges the channel to the *same* local endpoint instead
     * of a fixed one. Arrives before the first DATA frame on the channel.
     */
    private handleChannelOpen;
    private onChannelData;
    private ensureBridge;
    private sendHello;
    private sendBytes;
    private log;
}

export { CONTROL_CHANNEL, ControlOp, FLAG_FIN, type Frame, FrameType, HEADER_SIZE, MAGIC, RelayAgentClient, type RelayAgentClientOptions, type RelayHttpRequest, type RelayReadyInfo, type TryParseResult, VERSION, controlPayload, decodeFrame, encodeControl, encodeFrame, parseControl, tryParseFrame };
