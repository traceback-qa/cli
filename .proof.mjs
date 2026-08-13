import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8000/relay/view/0w74qa/stream');
let frames = 0, bytes = 0;
ws.on('message', (d, isBinary) => { if (isBinary) { frames++; bytes += d.length; } });
setTimeout(() => { console.log('PROOF frames=' + frames + ' bytes=' + bytes); process.exit(0); }, 10000);
