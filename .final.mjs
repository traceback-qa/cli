import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8000/relay/view/0w74qa/stream');
let frames = 0, bytes = 0;
ws.on('message', (d, isBinary) => { if (isBinary) { frames++; bytes += d.length; } });
ws.on('close', (c, r) => console.log('CLOSE code=' + c + ' reason=' + r.toString()));
setTimeout(() => { console.log('VIEWER frames=' + frames + ' bytes=' + bytes + (frames > 0 ? ' => STREAM WORKS' : ' => no frames (static screen)')); process.exit(0); }, 8000);
