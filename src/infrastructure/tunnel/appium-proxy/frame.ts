/**
 * Appium tunnel wire protocol — TS mirror of the backend's
 * src/contexts/appium_tunnel/domain/frame.py, kept in lockstep.
 *
 * Every WebSocket message is one JSON text frame, discriminated by `type`.
 */

export interface RequestFrame {
  type: 'request';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body_b64: string | null;
}

export interface ResponseFrame {
  type: 'response';
  id: string;
  status: number;
  headers: Record<string, string>;
  body_b64: string | null;
  error: string | null;
}

export interface PingFrame {
  type: 'ping';
  id: string;
  ts: number;
}

export interface PongFrame {
  type: 'pong';
  id: string;
  ts: number;
}

export type Frame = RequestFrame | ResponseFrame | PingFrame | PongFrame;

export const HEARTBEAT_TIMEOUT_MS = 45_000;

// Headers that describe a single transport hop, not the logical request/response —
// must never be forwarded verbatim in either direction. Matches the backend's
// HOP_BY_HOP_HEADERS exactly.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

export function stripHopByHop(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

export function parseFrame(raw: string): Frame {
  const parsed = JSON.parse(raw) as { type?: unknown };
  if (
    parsed.type !== 'request' &&
    parsed.type !== 'response' &&
    parsed.type !== 'ping' &&
    parsed.type !== 'pong'
  ) {
    throw new Error(`Unknown frame type: ${String(parsed.type)}`);
  }
  return parsed as Frame;
}
