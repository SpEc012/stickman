#!/usr/bin/env node
/* =====================================================================
   EMBER BLADES — game server for Node.  No dependencies:  node server.js

   - serves index.html and its icons over HTTP (so one process can host the whole game)
   - speaks WebSocket (RFC 6455, implemented below) on the same port
   - all lobby / relay logic lives in hub.mjs, which worker.mjs (Cloudflare) shares

   Environment: PORT (default 8080), HOST (default 0.0.0.0)
   ===================================================================== */
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');

const PORT = +process.env.PORT || 8080, HOST = process.env.HOST || '0.0.0.0', MAX_MSG = 16384;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

import('./hub.mjs').then(({ createHub }) => {
  const hub = createHub({ log });

  /* ------------------------------ HTTP ------------------------------ */
  // Static files: index.html plus the icons / share image that sit next to it. Only plain file names from this folder are served.
  const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
  const server = http.createServer((req, res) => {
    let url; try { url = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end('bad request'); }
    if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify(hub.health())); }
    const name = url === '/' ? 'index.html' : url.slice(1), type = TYPES[path.extname(name)];
    if (req.method !== 'GET' || !type || !/^[\w.-]+$/.test(name) || name.startsWith('.')) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(path.join(__dirname, name), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': type, 'cache-control': name === 'index.html' ? 'no-cache' : 'public, max-age=3600' }); res.end(data);
    });
  });

  /* ---------------------------- WebSocket ---------------------------- */
  const socks = new Set();
  function frame(op, payload) {
    const n = payload.length; let h;
    if (n < 126) { h = Buffer.allocUnsafe(2); h[1] = n; } else if (n < 65536) { h = Buffer.allocUnsafe(4); h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.allocUnsafe(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
    h[0] = 0x80 | op; return Buffer.concat([h, payload]);
  }
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sock.setNoDelay(true);
    const s = { sock, buf: Buffer.alloc(0), frag: null, fragOp: 0, open: true, conn: null };
    s.raw = b => { if (!s.open) return; if (sock.writableLength > 4 << 20) return s.kill(); sock.write(b); };
    s.kill = () => { if (!s.open) return; s.open = false; socks.delete(s); if (s.conn) hub.drop(s.conn); sock.destroy(); };
    s.conn = hub.connect({ text: str => s.raw(frame(1, Buffer.from(str))), bin: u8 => s.raw(frame(2, Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength))), buffered: () => sock.writableLength, close: () => { if (s.open) { s.open = false; socks.delete(s); sock.destroy(); } } });
    if (!s.conn) return;
    socks.add(s);
    sock.on('data', d => { try { onData(s, d); } catch (e) { log('bad frame', e.message); s.kill(); } });
    sock.on('close', s.kill); sock.on('error', s.kill);
  });
  function onData(s, d) {
    s.buf = s.buf.length ? Buffer.concat([s.buf, d]) : d;
    for (; ;) {
      const b = s.buf; if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) throw new Error('too long'); len = b.readUInt32BE(6); off = 10; }
      if (!masked) throw new Error('unmasked'); if (len > MAX_MSG) throw new Error('too long');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), data = Buffer.allocUnsafe(len); off += 4;
      for (let i = 0; i < len; i++) data[i] = b[off + i] ^ mask[i & 3];
      s.buf = b.subarray(off + len);
      if (op === 8) return s.kill();
      if (op === 9) { s.raw(frame(10, data)); continue; }
      if (op === 10) continue;
      if (op === 0) { if (!s.frag) throw new Error('stray continuation'); s.frag.push(data); if (s.frag.reduce((n, x) => n + x.length, 0) > MAX_MSG) throw new Error('too long'); if (fin) { const all = Buffer.concat(s.frag), bin = s.fragOp === 2; s.frag = null; hub.message(s.conn, bin ? all : all.toString('utf8')); } continue; }
      if (!fin) { s.frag = [data]; s.fragOp = op; continue; }
      hub.message(s.conn, op === 2 ? data : data.toString('utf8'));
      if (!s.open) return;
    }
  }
  setInterval(() => { for (const s of socks) s.raw(frame(9, Buffer.alloc(0))); }, 15000);      // keep-alive pings through proxies

  server.listen(PORT, HOST, () => log(`EMBER BLADES server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (WebSocket on the same port)`));
}).catch(e => { console.error('could not start:', e); process.exit(1); });
process.on('uncaughtException', e => log('uncaught', e.stack || e));
