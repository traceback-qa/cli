/**
 * Integration tests for RelayAgentClient - drives the real client against a ws
 * server speaking the backend broker protocol, plus a local http server standing in
 * for the developer's dev server. Proves the full agent loop: hello handshake,
 * http_request proxying -> http_response, ping -> pong, DATA channel bridging to a
 * local WebSocket endpoint, and backend-initiated close.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo, Socket } from 'node:net';
import { RelayAgentClient } from '../../../src/infrastructure/tunnel/relay/relay.client.js';
import {
  ControlOp,
  FrameType,
  type Frame,
  encodeControl,
  encodeFrame,
  parseControl,
  tryParseFrame,
} from '../../../src/infrastructure/tunnel/relay/frame.js';
import type { RawData } from 'ws';

const SESSION_ID = '00000000-0000-0000-0000-000000000001';

interface Stoppable {
  close: () => Promise<void>;
}

const stoppables: Stoppable[] = [];

function track<T extends Stoppable>(thing: T): T {
  stoppables.push(thing);
  return thing;
}

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((s) => s.close()));
});

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Local http server standing in for the developer's dev server (or a local Appium). */
async function startLocalHttpServer(
  body = 'hello from local',
): Promise<Stoppable & { port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    res.setHeader('x-test', 'yes');
    res.setHeader('content-type', 'text/plain');
    res.end(body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return track({
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  });
}

interface RelayHarness {
  port: number;
  send: (raw: Buffer) => void;
  frames: Frame[];
  waitForFrame: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
  onConnection: (handler: (socket: WsSocket) => void) => void;
}

/** A ws server that speaks the backend broker side of the relay protocol. */
async function startRelayWsServer(): Promise<Stoppable & RelayHarness> {
  let socket: WsSocket | null = null;
  let buffer = Buffer.alloc(0);
  const frames: Frame[] = [];
  const waiters: Array<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (err: Error) => void;
  }> = [];
  let connectionHandler: ((socket: WsSocket) => void) | null = null;

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    socket = ws;
    connectionHandler?.(ws);
    ws.on('message', (data: RawData) => {
      buffer = Buffer.concat([buffer, toBuf(data)]);
      while (true) {
        let parsed;
        try {
          parsed = tryParseFrame(buffer);
        } catch {
          buffer = Buffer.alloc(0);
          break;
        }
        if (!parsed.frame) break;
        buffer = parsed.rest;
        frames.push(parsed.frame);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const waiter = waiters[i]!;
          if (waiter.predicate(parsed.frame)) {
            waiters.splice(i, 1);
            waiter.resolve(parsed.frame);
          }
        }
      }
    });
  });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;

  return track({
    port,
    frames,
    send: (raw: Buffer) => {
      socket?.send(raw);
    },
    waitForFrame: (predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> =>
      new Promise<Frame>((resolve, reject) => {
        const found = frames.find(predicate);
        if (found) {
          resolve(found);
          return;
        }
        const waiter = { predicate, resolve, reject };
        waiters.push(waiter);
        setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) {
            waiters.splice(idx, 1);
            reject(new Error('timed out waiting for frame'));
          }
        }, timeoutMs);
      }),
    onConnection: (handler: (socket: WsSocket) => void) => {
      connectionHandler = handler;
    },
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  });
}

/** Local ws endpoint standing in for Metro's HMR socket; echoes with a prefix. */
async function startEchoWsServer(): Promise<Stoppable & { port: number }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (data: RawData) => {
      ws.send('echo:' + toBuf(data).toString());
    });
  });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  return track({
    port,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  });
}

/**
 * Local ws server that records the request path of every connection it accepts,
 * then echoes with a prefix. Used to prove the client bridges a device channel to
 * the path the backend announced (e.g. Metro's `/hot` HMR socket).
 */
async function startPathRecordingWsServer(): Promise<
  Stoppable & { port: number; paths: string[] }
> {
  const paths: string[] = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    paths.push(req.url ?? '');
    ws.on('message', (data: RawData) => {
      ws.send('echo:' + toBuf(data).toString());
    });
  });
  await once(wss, 'listening');
  const port = (wss.address() as AddressInfo).port;
  return track({
    port,
    paths,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  });
}

function toBuf(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((c) => Buffer.from(c)));
  return Buffer.from(data);
}

function makeClient(
  apiPort: number,
  localUrl: string,
  extra: Partial<ConstructorParameters<typeof RelayAgentClient>[0]> = {},
): RelayAgentClient {
  return new RelayAgentClient({
    apiUrl: 'http://127.0.0.1:' + apiPort,
    authToken: 'tb_live_test',
    sessionId: SESSION_ID,
    localUrl,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...extra,
  });
}

describe('RelayAgentClient', () => {
  it('attaches with the hello handshake and proxies HTTP requests to the local server', async () => {
    const local = await startLocalHttpServer();
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID, status: 'connected' }));
    });

    const onReady = vi.fn();
    const client = makeClient(relay.port, 'http://127.0.0.1:' + local.port, { onReady });

    await client.connect();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0]?.[0]?.status).toBe('connected');

    const responsePromise = relay.waitForFrame(
      (frame) =>
        frame.frameType === FrameType.CONTROL &&
        parseControl(frame.payload).op === ControlOp.HTTP_RESPONSE,
    );
    relay.send(
      encodeControl(ControlOp.HTTP_REQUEST, {
        request_id: 'req-1',
        method: 'GET',
        path: '/ping',
        query: 'x=1',
        headers: { 'x-device-token': 'tok-123' },
        body: '',
      }),
    );

    const responseFrame = await responsePromise;
    const payload = parseControl(responseFrame.payload);
    expect(payload.request_id).toBe('req-1');
    expect(payload.status).toBe(200);
    expect(Buffer.from(String(payload.body), 'base64').toString()).toBe('hello from local');

    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]?.url).toBe('/ping?x=1');
    expect(local.requests[0]?.headers['x-device-token']).toBe('tok-123');

    await client.stop();
  });

  it('answers ping with pong', async () => {
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const client = makeClient(relay.port, 'http://127.0.0.1:1');

    await client.connect();

    const pongPromise = relay.waitForFrame(
      (frame) =>
        frame.frameType === FrameType.CONTROL && parseControl(frame.payload).op === ControlOp.PONG,
    );
    relay.send(encodeControl(ControlOp.PING));

    const pong = await pongPromise;
    expect(parseControl(pong.payload).op).toBe('pong');
    await client.stop();
  });

  it('notifies when the backend closes the session', async () => {
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const onClosed = vi.fn();
    const client = makeClient(relay.port, 'http://127.0.0.1:1', { onClosed });

    await client.connect();
    relay.send(encodeControl(ControlOp.CLOSE, { reason: 'owner_ended' }));

    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(onClosed).toHaveBeenCalledWith('owner_ended');
  });

  it('bridges DATA frames to a local WebSocket endpoint and back', async () => {
    const bridge = await startEchoWsServer();
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const client = makeClient(relay.port, 'http://127.0.0.1:1', {
      localWsUrl: 'ws://127.0.0.1:' + bridge.port,
    });

    await client.connect();

    const backPromise = relay.waitForFrame(
      (frame) => frame.frameType === FrameType.DATA && frame.channelId === 5,
    );
    relay.send(
      encodeFrame({
        frameType: FrameType.DATA,
        channelId: 5,
        payload: Buffer.from('device-hello'),
        flags: 0,
      }),
    );

    const backFrame = await backPromise;
    expect(backFrame.payload.toString()).toBe('echo:device-hello');
    await client.stop();
  });

  it('forwards device payloads to the bridge as TEXT frames (Dart VM service rejects binary with 4001)', async () => {
    // The Dart VM service (Flutter hot reload) closes connections with close code
    // 4001 when a client sends a binary frame; it only speaks text JSON. The agent's
    // bridge must therefore send valid-UTF-8 payloads as text frames, falling back
    // to binary only for non-UTF-8 bytes.
    const received: Array<{ text: string; isBinary: boolean }> = [];
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      ws.on('message', (data: RawData, isBinary: boolean) => {
        received.push({ text: toBuf(data).toString(), isBinary });
        ws.send('echo:' + toBuf(data).toString('latin1'));
      });
    });

    async function waitForMessages(count: number): Promise<void> {
      for (let i = 0; i < 50 && received.length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await once(wss, 'listening');
    const port = (wss.address() as AddressInfo).port;
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const client = makeClient(relay.port, 'http://127.0.0.1:1', {
      localWsUrl: 'ws://127.0.0.1:' + port,
    });
    await client.connect();

    relay.send(encodeControl(ControlOp.CHANNEL_OPEN, { channel: 7, path: '/ws', query: '' }));
    const backPromise = relay.waitForFrame(
      (frame) => frame.frameType === FrameType.DATA && frame.channelId === 7,
    );

    // Text JSON (the VM service protocol) must arrive as a TEXT frame.
    relay.send(
      encodeFrame({
        frameType: FrameType.DATA,
        channelId: 7,
        payload: Buffer.from('{"jsonrpc":"2.0","id":1,"method":"getVersion"}'),
        flags: 0,
      }),
    );
    await backPromise;
    expect(received).toHaveLength(1);
    expect(received[0]?.isBinary).toBe(false);
    expect(received[0]?.text).toBe('{"jsonrpc":"2.0","id":1,"method":"getVersion"}'); // Non-UTF-8 bytes must still go as binary (never drop them).
    relay.send(
      encodeFrame({
        frameType: FrameType.DATA,
        channelId: 7,
        payload: Buffer.from([0xff, 0x00, 0xfe]),
        flags: 0,
      }),
    );
    await waitForMessages(2);
    expect(received).toHaveLength(2);
    expect(received[1]?.isBinary).toBe(true);

    await client.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('routes x-relay-target-port HTTP to the allowlisted local port (the cloud driving the user\'s Appium)', async () => {
    const appium = await startLocalHttpServer('hello from appium');
    const devServer = await startLocalHttpServer('hello from dev');
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const client = makeClient(relay.port, 'http://127.0.0.1:' + devServer.port, {
      allowedTargetPorts: new Set([appium.port]),
    });

    await client.connect();

    const responsePromise = relay.waitForFrame(
      (frame) =>
        frame.frameType === FrameType.CONTROL &&
        parseControl(frame.payload).op === ControlOp.HTTP_RESPONSE,
    );
    relay.send(
      encodeControl(ControlOp.HTTP_REQUEST, {
        request_id: 'appium-1',
        method: 'POST',
        path: '/wd/hub/session',
        query: '',
        headers: { 'x-relay-target-port': String(appium.port), 'content-type': 'application/json' },
        body: Buffer.from('{}').toString('base64'),
      }),
    );

    const responseFrame = await responsePromise;
    const payload = parseControl(responseFrame.payload);
    expect(payload.request_id).toBe('appium-1');
    expect(payload.status).toBe(200);
    expect(Buffer.from(String(payload.body), 'base64').toString()).toBe('hello from appium');

    // The tagged request reached the Appium stand-in, NOT the configured dev server...
    expect(appium.requests).toHaveLength(1);
    expect(appium.requests[0]?.url).toBe('/wd/hub/session');
    expect(devServer.requests).toHaveLength(0);
    // ...and the routing hint was stripped before forwarding.
    expect(appium.requests[0]?.headers['x-relay-target-port']).toBeUndefined();

    await client.stop();
  });

  it('rejects x-relay-target-port HTTP for ports outside the allowlist', async () => {
    const appium = await startLocalHttpServer('hello from appium');
    const devServer = await startLocalHttpServer('hello from dev');
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    // Allowlist does NOT include the appium stand-in's port.
    const client = makeClient(relay.port, 'http://127.0.0.1:' + devServer.port, {
      allowedTargetPorts: new Set([1]),
    });

    await client.connect();

    const responsePromise = relay.waitForFrame(
      (frame) =>
        frame.frameType === FrameType.CONTROL &&
        parseControl(frame.payload).op === ControlOp.HTTP_RESPONSE,
    );
    relay.send(
      encodeControl(ControlOp.HTTP_REQUEST, {
        request_id: 'appium-2',
        method: 'GET',
        path: '/wd/hub/status',
        query: '',
        headers: { 'x-relay-target-port': String(appium.port) },
        body: '',
      }),
    );

    const responseFrame = await responsePromise;
    const payload = parseControl(responseFrame.payload);
    expect(payload.request_id).toBe('appium-2');
    expect(payload.status).toBe(403);
    expect(appium.requests).toHaveLength(0);
    expect(devServer.requests).toHaveLength(0);

    await client.stop();
  });

  it('runs onRebuildRequest when the backend sends REBUILD and answers rebuild_done', async () => {
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const onRebuildRequest = vi.fn().mockResolvedValue({
      status: 'built',
      framework: 'ios',
      message: 'xcodebuild finished',
      startedAt: '2026-08-11T00:00:00.000Z',
      durationMs: 42_000,
    });
    const client = makeClient(relay.port, 'http://127.0.0.1:1', { onRebuildRequest });

    await client.connect();

    const donePromise = relay.waitForFrame(
      (frame) =>
        frame.frameType === FrameType.CONTROL &&
        parseControl(frame.payload).op === ControlOp.REBUILD_DONE,
    );
    relay.send(
      encodeControl(ControlOp.REBUILD, {
        request_id: 'rebuild-1',
        framework: 'ios',
        message: 'engine wants a fresh build',
      }),
    );

    const done = await donePromise;
    expect(onRebuildRequest).toHaveBeenCalledTimes(1);
    expect(onRebuildRequest.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'rebuild-1',
      framework: 'ios',
      message: 'engine wants a fresh build',
    });
    const payload = parseControl(done.payload);
    expect(payload.request_id).toBe('rebuild-1');
    expect(payload.status).toBe('built');
    expect(payload.duration_ms).toBe(42_000);

    await client.stop();
  });

  it('reports a failed rebuild when the handler throws', async () => {
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const onRebuildRequest = vi.fn().mockRejectedValue(new Error('xcodebuild exited with code 65'));
    const client = makeClient(relay.port, 'http://127.0.0.1:1', { onRebuildRequest });

    await client.connect();

    const donePromise = relay.waitForFrame(
      (frame) =>
        frame.frameType === FrameType.CONTROL &&
        parseControl(frame.payload).op === ControlOp.REBUILD_DONE,
    );
    relay.send(encodeControl(ControlOp.REBUILD, { request_id: 'rebuild-2', framework: 'kotlin' }));

    const done = await donePromise;
    const payload = parseControl(done.payload);
    expect(payload.request_id).toBe('rebuild-2');
    expect(payload.status).toBe('failed');
    expect(payload.message).toContain('xcodebuild exited with code 65');

    await client.stop();
  });

  it('sendRebuildDone reports a locally-performed rebuild to the backend', async () => {
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const client = makeClient(relay.port, 'http://127.0.0.1:1');

    await client.connect();

    const donePromise = relay.waitForFrame(
      (frame) =>
        frame.frameType === FrameType.CONTROL &&
        parseControl(frame.payload).op === ControlOp.REBUILD_DONE,
    );
    client.sendRebuildDone({
      status: 'built',
      framework: 'kotlin',
      message: 'gradlew installDebug done',
      startedAt: '2026-08-11T00:00:00.000Z',
      durationMs: 8_000,
    });

    const done = await donePromise;
    const payload = parseControl(done.payload);
    expect(payload.status).toBe('built');
    expect(payload.framework).toBe('kotlin');
    expect(payload.duration_ms).toBe(8_000);

    await client.stop();
  });

  it('bridges each device channel to the path the backend announced via channel_open', async () => {
    const bridge = await startPathRecordingWsServer();
    const relay = await startRelayWsServer();
    relay.onConnection((ws) => {
      ws.send(encodeControl(ControlOp.HELLO_ACK, { session_id: SESSION_ID }));
    });
    const client = makeClient(relay.port, 'http://127.0.0.1:1', {
      localWsUrl: 'ws://127.0.0.1:' + bridge.port,
    });

    await client.connect();

    // HMR channel: announced as /hot, then traffic flows.
    relay.send(encodeControl(ControlOp.CHANNEL_OPEN, { channel: 5, path: '/hot', query: '' }));
    const backPromise = relay.waitForFrame(
      (frame) => frame.frameType === FrameType.DATA && frame.channelId === 5,
    );
    relay.send(
      encodeFrame({
        frameType: FrameType.DATA,
        channelId: 5,
        payload: Buffer.from('register-entrypoints {}'),
        flags: 0,
      }),
    );

    const backFrame = await backPromise;
    expect(backFrame.payload.toString()).toBe('echo:register-entrypoints {}');
    expect(bridge.paths).toContain('/hot');

    // Message-socket channel on a different channel id: announced as /message.
    relay.send(encodeControl(ControlOp.CHANNEL_OPEN, { channel: 6, path: '/message', query: '' }));
    const backPromise2 = relay.waitForFrame(
      (frame) => frame.frameType === FrameType.DATA && frame.channelId === 6,
    );
    relay.send(
      encodeFrame({
        frameType: FrameType.DATA,
        channelId: 6,
        payload: Buffer.from('heartbeat'),
        flags: 0,
      }),
    );

    const backFrame2 = await backPromise2;
    expect(backFrame2.payload.toString()).toBe('echo:heartbeat');
    expect(bridge.paths).toContain('/message');
    await client.stop();
  });
});
