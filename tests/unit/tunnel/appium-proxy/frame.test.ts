/**
 * Unit tests for the Appium tunnel frame codec — the wire contract mirrored
 * lockstep with the backend's src/contexts/appium_tunnel/domain/frame.py.
 */
import { describe, it, expect } from 'vitest';
import { parseFrame, stripHopByHop } from '../../../../src/infrastructure/tunnel/appium-proxy/frame.js';

describe('parseFrame', () => {
  it('parses a request frame', () => {
    const raw = JSON.stringify({
      type: 'request',
      id: 'req-1',
      method: 'GET',
      path: '/status',
      headers: {},
      body_b64: null,
    });
    const frame = parseFrame(raw);
    expect(frame.type).toBe('request');
    expect(frame.id).toBe('req-1');
  });

  it('parses a response frame', () => {
    const raw = JSON.stringify({
      type: 'response',
      id: 'req-1',
      status: 200,
      headers: {},
      body_b64: null,
      error: null,
    });
    const frame = parseFrame(raw);
    expect(frame.type).toBe('response');
    if (frame.type === 'response') {
      expect(frame.status).toBe(200);
    }
  });

  it('parses ping and pong frames', () => {
    const ping = parseFrame(JSON.stringify({ type: 'ping', id: 'p1', ts: 1.0 }));
    const pong = parseFrame(JSON.stringify({ type: 'pong', id: 'p1', ts: 1.0 }));
    expect(ping.type).toBe('ping');
    expect(pong.type).toBe('pong');
  });

  it('throws on an unknown frame type', () => {
    expect(() => parseFrame(JSON.stringify({ type: 'bogus' }))).toThrow(/Unknown frame type/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseFrame('not valid json {{{')).toThrow();
  });
});

describe('stripHopByHop', () => {
  it('drops hop-by-hop headers case-insensitively', () => {
    const result = stripHopByHop({
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
      'Content-Length': '42',
      Host: 'localhost:4723',
      'X-Custom': 'value',
    });
    expect(result).toEqual({
      'Content-Type': 'application/json',
      'X-Custom': 'value',
    });
  });

  it('leaves an empty header set unchanged', () => {
    expect(stripHopByHop({})).toEqual({});
  });
});
