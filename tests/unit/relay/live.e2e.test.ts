/**
 * LIVE end-to-end test - runs only when LIVE_RELAY_URL is set.
 *
 * Drives the real RelayAgentClient against a real running relay server (uvicorn +
 * real Redis) and a real local dev server, proving the full loop over actual
 * network sockets: REST session create -> agent WS attach -> HTTP through the
 * public proxy path -> local server answer -> teardown.
 *
 *   LIVE_RELAY_URL=http://127.0.0.1:8010 pnpm vitest run tests/unit/relay/live.e2e.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  RelayAgentClient,
  type RelayReadyInfo,
} from '../../../src/infrastructure/tunnel/relay/index.js';

const LIVE = process.env['LIVE_RELAY_URL'];

interface SessionInfo {
  session_id: string;
  session_url: string;
  proxy_path: string;
  device_token: string;
  status: string;
}

describe.skipIf(!LIVE)('live relay e2e', () => {
  it('creates a session, attaches the agent, and serves HTTP through the proxy', async () => {
    const api = LIVE!;

    // 1. create the session via the REST endpoint
    const createRes = await fetch(api + '/api/v1/workspaces/ws-live/mobile-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tb_live_test' },
      body: JSON.stringify({ framework: 'expo' }),
    });
    expect(createRes.status).toBe(200);
    const session = (await createRes.json()) as SessionInfo;
    expect(session.session_id).toBeTruthy();
    expect(session.proxy_path).toMatch(/^\/relay\/s\//);

    // 2. attach the real agent client, proxying to the real local dev server
    const ready = new Promise<RelayReadyInfo>((resolve) => {
      const client = new RelayAgentClient({
        apiUrl: api,
        authToken: 'tb_live_test',
        sessionId: session.session_id,
        localUrl: 'http://127.0.0.1:8091',
        logger: { debug: () => undefined, warn: () => undefined },
        onReady: resolve,
      });
      void client.connect();
    });
    const info = await ready;
    expect(info.sessionId).toBe(session.session_id);

    // 3. a device fetches through the public proxy path - must hit the local server
    const proxyRes = await fetch(api + session.proxy_path + '/index.html', {
      headers: { 'x-device-token': session.device_token },
    });
    expect(proxyRes.status).toBe(200);
    const body = await proxyRes.text();
    expect(body).toContain('hello-from-local');
    expect(body).toContain('probe-ok');

    // 4. a wrong device token is rejected before reaching the agent
    const badRes = await fetch(api + session.proxy_path + '/index.html', {
      headers: { 'x-device-token': 'definitely-wrong' },
    });
    expect(badRes.status).toBe(401);

    // 5. status endpoint sees the active session
    const statusRes = await fetch(api + '/api/v1/workspaces/ws-live/mobile-sessions', {
      headers: { authorization: 'Bearer tb_live_test' },
    });
    const status = (await statusRes.json()) as { active: boolean; session_id?: string | null };
    expect(status.active).toBe(true);
    expect(status.session_id).toBe(session.session_id);

    // 6. teardown
    const delRes = await fetch(
      api + '/api/v1/workspaces/ws-live/mobile-sessions/' + session.session_id,
      { method: 'DELETE', headers: { authorization: 'Bearer tb_live_test' } },
    );
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { status: string }).status).toBe('ok');
  }, 30000);
});
