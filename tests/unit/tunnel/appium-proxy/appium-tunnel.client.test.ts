/**
 * Tests for the Appium tunnel client against a real local `ws` server (playing
 * the backend) and `nock`-mocked local Appium HTTP calls — covers the three
 * required behaviors: reconnect-with-backoff, request/response dispatch under
 * concurrency, and ping/pong.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import nock from 'nock';
import { connectAppiumTunnel } from '../../../../src/infrastructure/tunnel/appium-proxy/appium-tunnel.client.js';

let server: WebSocketServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  nock.cleanAll();
  nock.enableNetConnect();
});

function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const { port } = wss.address() as AddressInfo;
      resolve({ wss, port });
    });
  });
}

describe('connectAppiumTunnel', () => {
  it('connects and resolves once the handshake completes', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const handle = await connectAppiumTunnel({
      apiBaseUrl: `http://localhost:${port}`,
      authToken: 'tok',
      workspaceId: 'ws_1',
    });

    expect(handle.close).toBeInstanceOf(Function);
    handle.close();
  });

  it('rejects when the connection cannot be established', async () => {
    // Nothing listening on this port.
    await expect(
      connectAppiumTunnel({
        apiBaseUrl: 'http://localhost:1',
        authToken: 'tok',
        workspaceId: 'ws_1',
      }),
    ).rejects.toThrow(/Appium tunnel connection failed/);
  });

  it('replies with pong when the server sends a ping', async () => {
    const { wss, port } = await startServer();
    server = wss;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only wire message
    const pongReceived = new Promise<any>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'pong') resolve(msg);
        });
        ws.send(JSON.stringify({ type: 'ping', id: 'p1', ts: 1.0 }));
      });
    });

    const handle = await connectAppiumTunnel({
      apiBaseUrl: `http://localhost:${port}`,
      authToken: 'tok',
      workspaceId: 'ws_1',
    });

    const pong = await pongReceived;
    expect(pong.type).toBe('pong');
    expect(pong.id).toBe('p1');
    handle.close();
  });

  it('replays a request frame against local Appium and returns the response', async () => {
    const { wss, port } = await startServer();
    server = wss;

    nock('http://localhost:4723')
      .get('/status')
      .reply(200, { value: { ready: true } }, { 'Content-Type': 'application/json' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only wire message
    const responseReceived = new Promise<any>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'response') resolve(msg);
        });
        ws.send(
          JSON.stringify({
            type: 'request',
            id: 'req-1',
            method: 'GET',
            path: '/status',
            headers: {},
            body_b64: null,
          }),
        );
      });
    });

    const handle = await connectAppiumTunnel({
      apiBaseUrl: `http://localhost:${port}`,
      authToken: 'tok',
      workspaceId: 'ws_1',
    });

    const response = await responseReceived;
    expect(response.id).toBe('req-1');
    expect(response.status).toBe(200);
    const body = JSON.parse(Buffer.from(response.body_b64, 'base64').toString());
    expect(body.value.ready).toBe(true);
    handle.close();
  });

  it('returns a 502 response frame (never crashes) when local Appium is unreachable', async () => {
    const { wss, port } = await startServer();
    server = wss;
    // Block only the fake-Appium target -- the WS connection to our own test
    // server (a different local port) must stay reachable.
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes(String(port)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only wire message
    const responseReceived = new Promise<any>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'response') resolve(msg);
        });
        ws.send(
          JSON.stringify({
            type: 'request',
            id: 'req-2',
            method: 'GET',
            path: '/status',
            headers: {},
            body_b64: null,
          }),
        );
      });
    });

    const handle = await connectAppiumTunnel({
      apiBaseUrl: `http://localhost:${port}`,
      authToken: 'tok',
      workspaceId: 'ws_1',
    });

    const response = await responseReceived;
    expect(response.status).toBe(502);
    expect(response.error).toBeTruthy();
    handle.close();
  });

  it('dispatches concurrent request frames without blocking (task-per-frame)', async () => {
    const { wss, port } = await startServer();
    server = wss;

    nock('http://localhost:4723').get('/slow').delay(200).reply(200, { marker: 'slow' });
    nock('http://localhost:4723').get('/fast').reply(200, { marker: 'fast' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only wire messages
    const responses: any[] = [];
    const bothReceived = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'response') {
            responses.push(msg);
            if (responses.length === 2) resolve();
          }
        });
        ws.send(
          JSON.stringify({
            type: 'request',
            id: 'slow',
            method: 'GET',
            path: '/slow',
            headers: {},
            body_b64: null,
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'request',
            id: 'fast',
            method: 'GET',
            path: '/fast',
            headers: {},
            body_b64: null,
          }),
        );
      });
    });

    const handle = await connectAppiumTunnel({
      apiBaseUrl: `http://localhost:${port}`,
      authToken: 'tok',
      workspaceId: 'ws_1',
    });

    await bothReceived;

    // The fast request resolves first, proving the slow one being in-flight
    // doesn't block dispatch of/reply to the fast one.
    expect(responses[0].id).toBe('fast');
    expect(responses[1].id).toBe('slow');
    handle.close();
  });

  it('reconnects with backoff after the connection drops', async () => {
    const { wss, port } = await startServer();
    server = wss;

    let connectionCount = 0;
    const secondConnection = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        connectionCount += 1;
        if (connectionCount === 1) {
          setTimeout(() => ws.terminate(), 50);
        } else {
          resolve();
        }
      });
    });

    let reconnectAttempts = 0;
    const handle = await connectAppiumTunnel({
      apiBaseUrl: `http://localhost:${port}`,
      authToken: 'tok',
      workspaceId: 'ws_1',
      onReconnecting: () => {
        reconnectAttempts += 1;
      },
    });

    await secondConnection;
    expect(connectionCount).toBe(2);
    expect(reconnectAttempts).toBeGreaterThanOrEqual(1);
    handle.close();
  });

  it('close() stops further reconnection attempts', async () => {
    const { wss, port } = await startServer();
    server = wss;

    let connectionCount = 0;
    wss.on('connection', (ws) => {
      connectionCount += 1;
      ws.terminate();
    });

    const handle = await connectAppiumTunnel({
      apiBaseUrl: `http://localhost:${port}`,
      authToken: 'tok',
      workspaceId: 'ws_1',
    });
    handle.close();

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const countAfterClose = connectionCount;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(connectionCount).toBe(countAfterClose);
  });
});
