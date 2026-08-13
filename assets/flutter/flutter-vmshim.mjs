// Flutter VM-service shim v2 — self-healing tunnel endpoint (RN-style durability).
//
//   - `flutter attach --debug-url ws://127.0.0.1:9001/ws` connects here; every
//     byte is pumped through the relay tunnel as a device WebSocket to the
//     app's Dart VM service.
//   - The shim NEVER closes the attach socket. If the tunnel drops (backend
//     blip, agent restart, session rotation) it reconnects with exponential
//     backoff, re-reading the session + VM-service path files on every attempt
//     so an agent restart (new session code) or app restart (new VM auth) is
//     picked up without any manual rewiring. This mirrors how Expo Go keeps
//     reconnecting to Metro in the RN flow.
//   - The tool's DDS also pushes the hot-reload kernel over HTTP (DevFS PUTs);
//     those are forwarded through the tunnel's HTTP relay to the agent, which
//     proxies them to the local dev-server URL (the VM service port).
//   - Plain discovery GETs answer with the Dart VM service JSON the DDS probes.
import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';

// Everything is env-overridable so `mobile dev` can point this at the real backend
// (RELAY_API_HOST/PORT) and at its own session files (RELAY_SESSION_FILE /
// RELAY_VM_PATH_FILE) without touching code.
const SHIM_PORT = Number(process.env.SHIM_PORT || 9001);
const API_HOST = process.env.RELAY_API_HOST || '127.0.0.1';
const API_PORT = Number(process.env.RELAY_API_PORT || 8010);
const SESSION_FILE = process.env.RELAY_SESSION_FILE || '/tmp/relay_session_flutter.json';
const VM_PATH_FILE = process.env.RELAY_VM_PATH_FILE || '/tmp/vm_service_path.txt';
// VM mode (Topology A): the tunnel terminates at the BACKEND's /relay/s/<code>/vm/...
// route, which pipes to the CLOUD emulator's Dart VM service (no relay agent hop).
// Legacy mode keeps the original agent-bridged device route for user-owned devices.
const VM_MODE = process.env.RELAY_VM_MODE === '1';
const relayBase = () => {
  const s = readSession();
  if (!s) return null;
  return (VM_MODE ? '/relay/s/' + s.code + '/vm' : '/relay/s/' + s.code);
};
const MAX_PENDING = 256; // attach->tunnel buffer cap while reconnecting
const MIN_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 8000;
const CONFIG_POLL_MS = 500;

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}
function readVmPath() {
  try {
    return fs.readFileSync(VM_PATH_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const isDiscovery = req.method === 'GET' && !req.headers['dev_fs_name'];
  if (isDiscovery) {
    // Mimic the Dart VM service HTTP discovery endpoint (what DDS probes first).
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        host: '127.0.0.1',
        port: SHIM_PORT,
        authCode: '',
        uri: 'ws://127.0.0.1:' + SHIM_PORT + '/ws',
        webSocketUrl: 'ws://127.0.0.1:' + SHIM_PORT + '/ws',
      }),
    );
    return;
  }

  // Everything else (DevFS kernel PUTs, etc.) goes through the tunnel's HTTP relay.
  const s = readSession();
  const base = relayBase();
  if (!s || !base) {
    res.writeHead(503);
    res.end('shim: no session yet');
    return;
  }
  const headers = { ...req.headers, 'x-device-token': s.device_token };
  const preq = http.request(
    { host: API_HOST, port: API_PORT, path: base + req.url, method: req.method, headers },
    (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.pipe(res);
    },
  );
  preq.on('error', (e) => {
    res.writeHead(502);
    res.end('shim relay error: ' + e.message);
  });
  req.pipe(preq);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (attach) => {
    wss.emit('connection', attach, req);
  });
});

wss.on('connection', (attach) => {
  log('ATTACH_CONNECTED');
  const pending = []; // attach->tunnel messages held while the tunnel is down
  let tunnel = null;
  let backoff = MIN_BACKOFF_MS;
  let closed = false;
  let cfgTimer = null;

  function stop() {
    closed = true;
    if (cfgTimer) {
      clearTimeout(cfgTimer);
      cfgTimer = null;
    }
    if (tunnel) {
      try {
        tunnel.close();
      } catch {
        /* already closed */
      }
      tunnel = null;
    }
  }

  // The agent may start after the attach does — poll until config appears
  // instead of rejecting the attach (same tolerance as Expo Go waiting on Metro).
  function ensureConfig() {
    if (closed) return;
    const s = readSession();
    const path = readVmPath();
    if (s && path) {
      connectTunnel(s, path);
      return;
    }
    cfgTimer = setTimeout(ensureConfig, CONFIG_POLL_MS);
  }

  function connectTunnel(s, path) {
    if (closed || tunnel) return;
    // The config may carry a leading slash (it mirrors the VM service's auth path
    // `/TOKEN/ws`) — never build `vm//TOKEN/ws`; the VM service rejects the wrong path.
    const joinedPath = '/' + String(path || '').replace(/^\/+/g, '');
    const url =
      'ws://' +
      API_HOST +
      ':' +
      API_PORT +
      (VM_MODE ? '/relay/s/' + s.code + '/vm' : '/relay/s/' + s.code) +
      joinedPath +
      '?token=' +
      s.device_token;
    log('TUNNEL_TRY ' + url.replace(s.device_token, '***'));
    const ws = new WebSocket(url);
    tunnel = ws;

    // Handlers capture `ws` (not the outer `tunnel`) and bail when the socket is no
    // longer current, so a stale event from a replaced connection can never close or
    // null the live one (which would dead-lock the reconnect loop).
    ws.on('open', () => {
      if (tunnel !== ws) return;
      log('TUNNEL_OPEN');
      backoff = MIN_BACKOFF_MS;
      // Flush anything the attach sent while we were reconnecting.
      while (pending.length > 0) {
        const m = pending.shift();
        if (tunnel === ws && ws.readyState === WebSocket.OPEN) {
          ws.send(m);
        } else {
          pending.unshift(m);
          break;
        }
      }
    });
    ws.on('message', (d) => {
      if (attach.readyState === WebSocket.OPEN) {
        attach.send(d.toString());
      }
    });
    ws.on('close', (c) => {
      if (tunnel !== ws) return;
      log('TUNNEL_CLOSE ' + c + ' -> retry in ' + backoff + 'ms (attach stays connected)');
      tunnel = null;
      if (closed) return;
      const delay = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      setTimeout(() => {
        if (closed) return;
        const s2 = readSession();
        const p2 = readVmPath();
        if (s2 && p2) {
          connectTunnel(s2, p2);
        } else {
          ensureConfig();
        }
      }, delay);
    });
    ws.on('error', (e) => {
      if (tunnel !== ws) return;
      log('TUNNEL_ERR ' + e.message);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    });
  }

  attach.on('message', (d) => {
    if (tunnel && tunnel.readyState === WebSocket.OPEN) {
      tunnel.send(d.toString());
      return;
    }
    // Reconnecting: hold small frames; drop the oldest if the cap is hit so a
    // flood (never a kernel — those ride HTTP) can't grow the buffer forever.
    if (pending.length >= MAX_PENDING) {
      pending.shift();
      log('PENDING_DROP cap=' + MAX_PENDING);
    }
    pending.push(d);
  });
  attach.on('close', () => {
    log('ATTACH_CLOSE');
    stop();
  });
  attach.on('error', () => {});

  ensureConfig();
});

server.listen(SHIM_PORT, () => log('SHIM_LISTENING :' + SHIM_PORT));
