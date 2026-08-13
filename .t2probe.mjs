import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:9001/ws');
let done = false;
ws.on('open', () => { ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVM', params: {} })); });
ws.on('message', (d) => { console.log('PROBE ANSWER:', String(d).slice(0, 60)); done = true; ws.close(); process.exit(0); });
ws.on('error', (e) => { console.log('PROBE ERROR:', e.message); process.exit(1); });
setTimeout(() => { if (!done) { console.log('PROBE TIMEOUT'); process.exit(1); } }, 12000);
