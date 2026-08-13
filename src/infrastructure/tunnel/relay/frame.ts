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
export const MAGIC = Buffer.from([0x54, 0x52, 0x45, 0x4c]);

export const VERSION = 1;
export const HEADER_SIZE = 15;

/** Channel 0 is reserved for the control plane; device channels start at 1. */
export const CONTROL_CHANNEL = 0;

export const FLAG_FIN = 0b0000_0001;

export enum FrameType {
  CONTROL = 1,
  DATA = 2,
  STREAM = 3,
  CLOSE = 4,
}

export enum ControlOp {
  HELLO = 'hello',
  HELLO_ACK = 'hello_ack',
  RESUME = 'resume',
  RESUME_ACK = 'resume_ack',
  SESSION_URL = 'session_url',
  REGISTER_DEVICE_ENDPOINT = 'register_device_endpoint',
  DEVICE_ENDPOINT_REGISTERED = 'device_endpoint_registered',
  HTTP_REQUEST = 'http_request',
  HTTP_RESPONSE = 'http_response',
  CHANNEL_OPEN = 'channel_open',
  HOT_RELOAD = 'hot_reload',
  HOT_RESTART = 'hot_restart',
  REBUILD = 'rebuild',
  REBUILD_DONE = 'rebuild_done',
  PING = 'ping',
  PONG = 'pong',
  CLOSE = 'close',
  ERROR = 'error',
}

export interface Frame {
  frameType: FrameType;
  channelId: number;
  payload: Buffer;
  flags: number;
}

/** Encode a frame to its full wire representation (header + payload). */
export function encodeFrame(frame: Frame): Buffer {
  if (frame.payload.length > 0xffff_ffff) {
    throw new Error('frame payload exceeds 4 GiB');
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

/** Build the JSON payload of a CONTROL frame. */
export function controlPayload(op: ControlOp | string, data?: Record<string, unknown>): Buffer {
  const payload: Record<string, unknown> = { op };
  if (data) {
    Object.assign(payload, data);
  }
  return Buffer.from(JSON.stringify(payload));
}

/** Encode a CONTROL frame for the given op and optional JSON payload. */
export function encodeControl(
  op: ControlOp | string,
  data?: Record<string, unknown>,
  channelId: number = CONTROL_CHANNEL,
): Buffer {
  return encodeFrame({
    frameType: FrameType.CONTROL,
    channelId,
    payload: controlPayload(op, data),
    flags: 0,
  });
}

/** Decode a CONTROL frame payload into a plain object. */
export function parseControl(payload: Buffer): Record<string, unknown> {
  return JSON.parse(payload.toString('utf-8')) as Record<string, unknown>;
}

/** Parse exactly one frame from a buffer exactly `HEADER_SIZE + length` bytes long. */
export function decodeFrame(data: Buffer): Frame {
  const parsed = tryParseFrame(data);
  if (!parsed.frame) {
    throw new Error('incomplete frame buffer');
  }
  if (parsed.rest.length > 0) {
    throw new Error('trailing bytes after frame');
  }
  return parsed.frame;
}

export interface TryParseResult {
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
export function tryParseFrame(buffer: Buffer): TryParseResult {
  if (buffer.length < HEADER_SIZE) {
    return { frame: null, rest: buffer };
  }
  if (!buffer.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`bad frame magic: ${buffer.subarray(0, 4).toString('hex')}`);
  }
  const version = buffer[4]!;
  if (version !== VERSION) {
    throw new Error(`unsupported frame version: ${version}`);
  }
  const frameTypeValue = buffer[5]!;
  if (!(frameTypeValue in FrameType)) {
    throw new Error(`unknown frame type: ${frameTypeValue}`);
  }
  const flags = buffer[6]!;
  const channelId = buffer.readUInt32BE(7);
  const length = buffer.readUInt32BE(11);
  if (buffer.length < HEADER_SIZE + length) {
    return { frame: null, rest: buffer };
  }
  return {
    frame: {
      frameType: frameTypeValue as FrameType,
      channelId,
      payload: buffer.subarray(HEADER_SIZE, HEADER_SIZE + length),
      flags,
    },
    rest: buffer.subarray(HEADER_SIZE + length),
  };
}
