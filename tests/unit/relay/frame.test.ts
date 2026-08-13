/**
 * Unit tests for the relay binary frame codec - the byte-level contract shared with
 * the backend's src/contexts/relay/domain/frame.py.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTROL_CHANNEL,
  ControlOp,
  FrameType,
  MAGIC,
  VERSION,
  controlPayload,
  decodeFrame,
  encodeControl,
  encodeFrame,
  parseControl,
  tryParseFrame,
} from '../../../src/infrastructure/tunnel/relay/frame.js';

describe('frame codec', () => {
  it('round-trips a DATA frame with a binary payload', () => {
    const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    const raw = encodeFrame({ frameType: FrameType.DATA, channelId: 7, payload, flags: 0 });

    expect(raw.length).toBe(15 + payload.length);
    expect(raw.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(raw[4]).toBe(VERSION);
    expect(raw[5]).toBe(FrameType.DATA);
    expect(raw.readUInt32BE(7)).toBe(7);
    expect(raw.readUInt32BE(11)).toBe(payload.length);

    const decoded = decodeFrame(raw);
    expect(decoded.frameType).toBe(FrameType.DATA);
    expect(decoded.channelId).toBe(7);
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it('encodes a CONTROL frame with the op value (not the enum name)', () => {
    const raw = encodeControl(ControlOp.PING);
    const frame = decodeFrame(raw);
    expect(frame.frameType).toBe(FrameType.CONTROL);
    expect(frame.channelId).toBe(CONTROL_CHANNEL);
    const data = parseControl(frame.payload);
    expect(data.op).toBe('ping');
  });

  it('merges extra payload fields into control frames', () => {
    const raw = encodeControl(ControlOp.HELLO_ACK, { session_id: 'abc', status: 'connected' });
    const data = parseControl(decodeFrame(raw).payload);
    expect(data.op).toBe('hello_ack');
    expect(data.session_id).toBe('abc');
    expect(data.status).toBe('connected');
  });

  it('keeps the magic out of the JSON payload', () => {
    const payload = controlPayload(ControlOp.HELLO);
    expect(JSON.parse(payload.toString('utf-8'))).toEqual({ op: 'hello' });
  });

  it('returns null while a frame is incomplete, then parses once complete', () => {
    const raw = encodeFrame({
      frameType: FrameType.STREAM,
      channelId: 3,
      payload: Buffer.from('partial'),
      flags: 1,
    });
    const head = raw.subarray(0, 10);
    const tail = raw.subarray(10);

    const incomplete = tryParseFrame(head);
    expect(incomplete.frame).toBeNull();
    expect(incomplete.rest.length).toBe(head.length);

    const complete = tryParseFrame(Buffer.concat([head, tail]));
    expect(complete.frame).not.toBeNull();
    expect(complete.frame?.channelId).toBe(3);
    expect(complete.frame?.flags).toBe(1);
    expect(complete.frame?.payload.toString()).toBe('partial');
    expect(complete.rest.length).toBe(0);
  });

  it('parses two concatenated frames and returns the second as rest', () => {
    const a = encodeControl(ControlOp.PING);
    const b = encodeControl(ControlOp.PONG);
    const parsed = tryParseFrame(Buffer.concat([a, b]));
    expect(parsed.frame?.payload.toString()).toContain('ping');
    expect(parsed.rest.equals(b)).toBe(true);
  });

  it('throws on a bad magic', () => {
    const junk = Buffer.alloc(20, 0xff);
    expect(() => tryParseFrame(junk)).toThrow(/bad frame magic/);
  });

  it('throws on an unknown frame type', () => {
    const raw = encodeControl(ControlOp.PING);
    const broken = Buffer.from(raw);
    broken[5] = 99;
    expect(() => tryParseFrame(broken)).toThrow(/unknown frame type/);
  });

  it('throws on an unsupported version', () => {
    const raw = encodeControl(ControlOp.PING);
    const broken = Buffer.from(raw);
    broken[4] = 2;
    expect(() => tryParseFrame(broken)).toThrow(/unsupported frame version/);
  });

  it('decodeFrame rejects trailing bytes', () => {
    const raw = encodeControl(ControlOp.PING);
    expect(() => decodeFrame(Buffer.concat([raw, Buffer.from([0])]))).toThrow(/trailing bytes/);
  });
});
