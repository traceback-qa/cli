// Real relay agent for the emulator test: creates a session and attaches the
// actual RelayAgentClient from the CLI, proxying to local Metro on :8081.
import fs from 'node:fs';
import { RelayAgentClient } from './.relay-agent/index.js';

const api = 'http://127.0.0.1:8010';
const res = await fetch(api + '/api/v1/workspaces/ws-live/mobile-sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer tb_live_test' },
  body: JSON.stringify({ framework: 'expo' }),
});
const s = await res.json();
if (!s.session_id) {
  console.error('SESSION_CREATE_FAILED ' + JSON.stringify(s));
  process.exit(1);
}
const code = s.proxy_path.split('/')[3];
fs.writeFileSync(
  '/tmp/relay_session.json',
  JSON.stringify({
    session_id: s.session_id,
    code,
    device_token: s.device_token,
    proxy_path: s.proxy_path,
    session_url: s.session_url,
  }),
);
console.log('SESSION_CREATED ' + JSON.stringify(s));

const client = new RelayAgentClient({
  apiUrl: api,
  authToken: 'tb_live_test',
  sessionId: s.session_id,
  localUrl: 'http://localhost:8081',
  localWsUrl: 'ws://localhost:8081',
  logger: {
    debug: (m) => console.log('AGENT ' + m),
    warn: (m) => console.log('AGENT_WARN ' + m),
  },
  onReady: (info) => console.log('AGENT_READY session=' + info.sessionId + ' code=' + info.code),
  onClosed: (reason) => {
    console.log('AGENT_CLOSED ' + reason);
    process.exit(0);
  },
});
await client.connect();
console.log('AGENT_CONNECTED');
setInterval(() => {}, 1000);
