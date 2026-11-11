#!/usr/bin/env node
/* =====================================================================
   EMBER BLADES — lobby + relay server.  No dependencies: `node server.js`.

   What it does
     - serves index.html and its icons over HTTP (so one process can host the whole game)
     - speaks WebSocket (RFC 6455, implemented below) on the same port
     - lobbies: create / list / join by code / quick join, host settings, host migration
     - during a match it relays 18-byte fighter records and combat events, counts
       kills, runs the clock and decides the winner

   What it does NOT do: simulate the fight. Each client simulates the fighters it
   owns and decides the hits that land on them; the server only checks that a
   client writes to slots it owns. That keeps latency low and the server tiny,
   and it means a modified client could cheat — fine for playing with friends.

   Environment: PORT (default 8080), HOST (default 0.0.0.0)
   ===================================================================== */
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');

const PORT = +process.env.PORT || 8080, HOST = process.env.HOST || '0.0.0.0';
const REC = 18, SLOTS = 64, MAX_FIGHTERS = 50, MAX_ROOMS = 300, MAX_CONNS = 2000, MAX_MSG = 16384;
const N_MAPS = 6, TIMES = [120, 180, 300, 480], FILL = [2, 4, 6, 8, 12, 16, 24, 32, 40, 50], INTRO_MS = 1750, END_MS = 9000;
const BOT_NAMES = ['ASH', 'VEX', 'NOVA', 'RIFT', 'KAEL', 'ONYX', 'PYRE', 'ZEN', 'MOTH', 'DUSK', 'IRIS', 'JINX', 'LYNX', 'ORCA', 'RUNE', 'SOOT', 'TALON', 'UMBRA', 'WISP', 'XAN', 'YARA', 'ZEPH', 'BLAZE', 'CROW', 'DRIFT', 'ECHO', 'FANG', 'GLINT', 'HEX', 'IVO', 'JADE', 'KITE', 'LUX', 'MIRE', 'NYX', 'OPAL', 'PIKE', 'QUILL', 'REED', 'SLATE', 'THORN', 'ULRIC', 'VALE', 'WREN', 'XYLA', 'YEW', 'ZARA', 'BRAND', 'CINDER', 'DART'];
const COLS = ['blue', 'red', 'green', 'purple', 'yellow', 'orange', 'white'];

const rooms = new Map(), conns = new Set();
let nextId = 1;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const clampInt = (v, lo, hi, d) => { v = Math.floor(+v); return v >= lo && v <= hi ? v : d; };
const cleanName = (s, d, max) => { s = String(s || '').replace(/[^\w \-.!?']/g, '').trim().slice(0, max || 14).toUpperCase(); return s || d; };

/* ------------------------------ HTTP ------------------------------ */
// Static files: index.html plus the icons / share image that sit next to it. Only plain file names from this folder are served.
const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: conns.size })); }
  const name = url === '/' ? 'index.html' : url.slice(1), type = TYPES[path.extname(name)];
  if (req.method !== 'GET' || !type || !/^[\w.-]+$/.test(name) || name.startsWith('.')) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': type, 'cache-control': name === 'index.html' ? 'no-cache' : 'public, max-age=3600' }); res.end(data);
  });
});

/* ---------------------------- WebSocket ---------------------------- */
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || conns.size >= MAX_CONNS) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, id: nextId++, name: 'PLAYER', look: 0, col: 'blue', room: null, slot: -1, buf: Buffer.alloc(0), frag: null, fragOp: 0, n: 0, nT: Date.now(), ping: 0, alive: true, last: Date.now() };
  conns.add(c);
  sock.on('data', d => { try { onData(c, d); } catch (e) { log('bad frame from', c.id, e.message); drop(c); } });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
  send(c, { t: 'welcome', id: c.id });
});
function frame(op, payload) {
  const n = payload.length; let h;
  if (n < 126) { h = Buffer.allocUnsafe(2); h[1] = n; } else if (n < 65536) { h = Buffer.allocUnsafe(4); h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.allocUnsafe(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  h[0] = 0x80 | op; return Buffer.concat([h, payload]);
}
function rawSend(c, buf, droppable) {
  if (!c.alive) return;
  if (droppable && c.sock.writableLength > 262144) return;        // a slow client skips state frames instead of queueing them
  if (c.sock.writableLength > 4 << 20) return drop(c);
  c.sock.write(buf);
}
function send(c, obj) { rawSend(c, frame(1, Buffer.from(JSON.stringify(obj)))); }
function onData(c, d) {
  c.buf = c.buf.length ? Buffer.concat([c.buf, d]) : d;
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80; let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) throw new Error('too long'); len = b.readUInt32BE(6); off = 10; }
    if (!masked) throw new Error('unmasked'); if (len > MAX_MSG) throw new Error('too long');
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4), data = Buffer.allocUnsafe(len); off += 4;
    for (let i = 0; i < len; i++) data[i] = b[off + i] ^ mask[i & 3];
    c.buf = b.subarray(off + len);
    if (op === 8) return drop(c);
    if (op === 9) { rawSend(c, frame(10, data)); continue; }
    if (op === 10) continue;
    if (op === 0) { if (!c.frag) throw new Error('stray continuation'); c.frag.push(data); if (c.frag.reduce((s, x) => s + x.length, 0) > MAX_MSG) throw new Error('too long'); if (fin) { const all = Buffer.concat(c.frag); c.frag = null; onMessage(c, all, c.fragOp === 2); } continue; }
    if (!fin) { c.frag = [data]; c.fragOp = op; continue; }
    onMessage(c, data, op === 2);
    if (!c.alive) return;
  }
}
function drop(c) {
  if (!c.alive) return; c.alive = false; conns.delete(c);
  try { leaveRoom(c); } catch (e) { log('leave error', e.message); }
  c.sock.destroy();
}

/* ------------------------------ rooms ------------------------------ */
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (;;) { let s = ''; for (let i = 0; i < 4; i++) s += A[crypto.randomInt(A.length)]; if (!rooms.has(s)) return s; } }
function humans(r) { return r.conns.size; }
function roomInfo(r) {
  return { t: 'room', code: r.code, name: r.name, host: r.host.id, set: r.set, state: r.state, priv: r.priv,
    players: [...r.conns].map(c => ({ id: c.id, name: c.name, look: c.look, col: c.col, slot: c.slot, team: r.slots[c.slot] ? r.slots[c.slot].team : 0, ping: c.ping })) };
}
function bcast(r, obj, except) { const f = frame(1, Buffer.from(JSON.stringify(obj))); for (const c of r.conns) if (c !== except) rawSend(c, f); }
function sendRoom(r) { const info = roomInfo(r); for (const c of r.conns) send(c, Object.assign({ you: c.id, slot: c.slot }, info)); }
function lobbyList() {
  const out = [];
  for (const r of rooms.values()) { if (r.priv) continue; out.push({ code: r.code, name: r.name, n: humans(r), max: MAX_FIGHTERS, map: r.set.map, mode: r.set.mode, state: r.state }); if (out.length >= 60) break; }
  return out;
}
function freeSlot(r) { for (let i = 0; i < MAX_FIGHTERS; i++) if (!r.slots[i]) return i; return -1; }
function fighters(r) { let n = 0; for (let i = 0; i < SLOTS; i++) if (r.slots[i]) n++; return n; }
function teamFor(r) { let a = 0, b = 0; for (const s of r.slots) if (s) { if (s.team === 1) a++; else if (s.team === 2) b++; } return a <= b ? 1 : 2; }
function entry(r, i) { const s = r.slots[i]; return { slot: i, name: s.name, look: s.look, col: s.col, team: s.team, owner: s.owner.id, bot: s.bot }; }
function createRoom(c, m) {
  if (rooms.size >= MAX_ROOMS) return send(c, { t: 'err', msg: 'The server is full. Try again later.' });
  leaveRoom(c);
  const r = { code: newCode(), name: cleanName(m.name, c.name + "'S LOBBY", 24), host: c, priv: !!m.priv, conns: new Set(), slots: new Array(SLOTS).fill(null), set: { map: 1, mode: 0, time: 2, fill: 3, tier: 2 }, state: 'lobby',
    states: Buffer.alloc(SLOTS * REC), has: new Uint8Array(SLOTS), kills: new Int16Array(SLOTS), deaths: new Int16Array(SLOTS), dead: new Uint8Array(SLOTS), seed: 1, startAt: 0, timer: null, tick: 0 };
  rooms.set(r.code, r); joinRoom(c, r); log('room', r.code, 'created by', c.name);
}
function joinRoom(c, r) {
  if (c.room === r) return;
  leaveRoom(c);
  let slot = freeSlot(r);
  if (slot < 0 || fighters(r) >= MAX_FIGHTERS) {                      // full: make room by retiring a bot, if there is one
    let b = -1; for (let i = SLOTS - 1; i >= 0; i--) if (r.slots[i] && r.slots[i].bot) { b = i; break; }
    if (b < 0) return send(c, { t: 'err', msg: 'That lobby is full.' });
    removeSlot(r, b); slot = freeSlot(r); if (slot < 0) return send(c, { t: 'err', msg: 'That lobby is full.' });
  }
  c.room = r; c.slot = slot; r.conns.add(c);
  r.slots[slot] = { owner: c, bot: false, name: c.name, look: c.look, col: c.col, team: teamFor(r) };
  sendRoom(r);
  if (r.state === 'play') {                                          // joining a match in progress
    bcast(r, { t: 'add', r: entry(r, slot) }, c);
    send(c, startMsg(r));
  }
}
function removeSlot(r, i) { if (!r.slots[i]) return; r.slots[i] = null; r.has[i] = 0; if (r.state !== 'lobby') bcast(r, { t: 'del', slot: i }); }
function leaveRoom(c) {
  const r = c.room; if (!r) return;
  c.room = null; r.conns.delete(c); removeSlot(r, c.slot); c.slot = -1;
  if (!r.conns.size) { clearTimeout(r.timer); rooms.delete(r.code); log('room', r.code, 'closed'); return; }
  if (r.host === c) {                                                // host left: the next player inherits the lobby and its bots
    r.host = r.conns.values().next().value; const own = [];
    for (let i = 0; i < SLOTS; i++) if (r.slots[i] && r.slots[i].bot) { r.slots[i].owner = r.host; own.push(i); }
    if (r.state !== 'lobby') bcast(r, { t: 'own', id: r.host.id, slots: own });
  }
  sendRoom(r);
  if (r.state === 'play' && r.set.mode === 2) checkLast(r);
}
function startMsg(r) {
  const roster = []; for (let i = 0; i < SLOTS; i++) if (r.slots[i]) roster.push(entry(r, i));
  const scores = []; for (let i = 0; i < SLOTS; i++) if (r.kills[i] || r.deaths[i]) scores.push([i, r.kills[i], r.deaths[i]]);
  return { t: 'start', seed: r.seed, set: r.set, roster, scores, elapsed: Date.now() - r.startAt };
}
function startMatch(r) {
  for (let i = 0; i < SLOTS; i++) if (r.slots[i] && r.slots[i].bot) r.slots[i] = null;
  r.kills.fill(0); r.deaths.fill(0); r.dead.fill(0); r.has.fill(0);
  let k = 0; for (const c of r.conns) if (r.slots[c.slot]) r.slots[c.slot].team = (k++ % 2) + 1;
  const total = Math.min(MAX_FIGHTERS, FILL[r.set.fill]); let n = humans(r), bi = 0;
  for (let i = SLOTS - 1; i >= MAX_FIGHTERS && n < total; i--, n++, bi++) r.slots[i] = { owner: r.host, bot: true, name: BOT_NAMES[bi % BOT_NAMES.length], look: (bi * 7 + 1) % 5, col: COLS[(bi * 3 + 1) % COLS.length], team: (n % 2) + 1 };
  for (let i = 0; n < total && i < MAX_FIGHTERS; i++) if (!r.slots[i]) { r.slots[i] = { owner: r.host, bot: true, name: BOT_NAMES[bi % BOT_NAMES.length], look: (bi * 7 + 1) % 5, col: COLS[(bi * 3 + 1) % COLS.length], team: (n % 2) + 1 }; n++; bi++; }
  r.seed = crypto.randomInt(1, 0xffffff); r.state = 'play'; r.startAt = Date.now();
  clearTimeout(r.timer); r.timer = setTimeout(() => endMatch(r), TIMES[r.set.time] * 1000 + INTRO_MS);
  const msg = startMsg(r); for (const c of r.conns) send(c, msg);
  log('room', r.code, 'match start:', humans(r), 'players,', n - humans(r), 'bots, map', r.set.map, 'mode', r.set.mode);
}
function checkLast(r) {
  let alive = 0, last = -1; for (let i = 0; i < SLOTS; i++) if (r.slots[i] && !r.dead[i]) { alive++; last = i; }
  if (alive <= 1 && fighters(r) > 1) endMatch(r, last);
}
function endMatch(r, lastAlive) {
  if (r.state !== 'play') return; clearTimeout(r.timer); r.state = 'ended';
  let w = -1, team = 0;
  if (r.set.mode === 1) { let a = 0, b = 0; for (let i = 0; i < SLOTS; i++) if (r.slots[i]) { if (r.slots[i].team === 1) a += r.kills[i]; else b += r.kills[i]; } team = a === b ? 0 : a > b ? 1 : 2; }
  else if (r.set.mode === 2 && lastAlive !== undefined && lastAlive >= 0) w = lastAlive;
  else { for (let i = 0; i < SLOTS; i++) if (r.slots[i] && (w < 0 || r.kills[i] > r.kills[w] || (r.kills[i] === r.kills[w] && r.deaths[i] < r.deaths[w]))) w = i; }
  bcast(r, { t: 'end', w, team });
  r.timer = setTimeout(() => { if (!rooms.has(r.code)) return; r.state = 'lobby'; for (let i = 0; i < SLOTS; i++) if (r.slots[i] && r.slots[i].bot) r.slots[i] = null; sendRoom(r); }, END_MS);
}

/* ----------------------------- messages ----------------------------- */
function onMessage(c, data, binary) {
  const now = Date.now(); c.last = now;
  if (now - c.nT > 1000) { c.nT = now; c.n = 0; } if (++c.n > 400) throw new Error('flood');
  const r = c.room;
  if (binary) {                                                       // fighter records: [1][count][count * 18 bytes]
    if (!r || r.state !== 'play' || data.length < 2 || data[0] !== 1) return;
    const n = data[1]; if (data.length !== 2 + n * REC) return;
    let ok = 0, w = 2;                                                // keep only records for slots this client owns
    for (let i = 0, o = 2; i < n; i++, o += REC) { const s = data[o], sl = s < SLOTS ? r.slots[s] : null; if (!sl || sl.owner !== c) continue; data.copy(r.states, s * REC, o, o + REC); r.has[s] = 1; if (w !== o) data.copy(data, w, o, o + REC); w += REC; ok++; }
    if (ok && r.conns.size <= 8) { data[1] = ok; const f = frame(2, data.subarray(0, w)); for (const o of r.conns) if (o !== c) rawSend(o, f, true); }   // small lobbies: forward at once
    return;
  }
  let m; try { m = JSON.parse(data.toString('utf8')); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello': c.name = cleanName(m.name, 'PLAYER' + (c.id % 100)); c.look = clampInt(m.look, 0, 4, 0); c.col = COLS.includes(m.col) ? m.col : 'blue'; break;
    case 'list': send(c, { t: 'lobbies', list: lobbyList() }); break;
    case 'create': createRoom(c, m); break;
    case 'join': { const rr = rooms.get(String(m.code || '').toUpperCase().trim()); if (!rr) return send(c, { t: 'err', msg: 'No lobby with that code.' }); joinRoom(c, rr); break; }
    case 'quick': { let best = null; for (const rr of rooms.values()) if (!rr.priv && humans(rr) < MAX_FIGHTERS && (!best || humans(rr) > humans(best))) best = rr; if (best) joinRoom(c, best); else createRoom(c, { name: '' }); break; }
    case 'leave': leaveRoom(c); send(c, { t: 'left' }); break;
    case 'me': if (r) { c.look = clampInt(m.look, 0, 4, c.look); if (COLS.includes(m.col)) c.col = m.col; const s = r.slots[c.slot]; if (s && r.state === 'lobby') { s.look = c.look; s.col = c.col; } sendRoom(r); } break;
    case 'set': if (r && r.host === c && r.state === 'lobby' && m.set) { const s = m.set, o = r.set; o.map = clampInt(s.map, 0, N_MAPS - 1, o.map); o.mode = clampInt(s.mode, 0, 2, o.mode); o.time = clampInt(s.time, 0, TIMES.length - 1, o.time); o.fill = clampInt(s.fill, 0, FILL.length - 1, o.fill); o.tier = clampInt(s.tier, 0, 4, o.tier); if (typeof m.priv === 'boolean') r.priv = m.priv; sendRoom(r); } break;
    case 'start': if (r && r.host === c && r.state === 'lobby') startMatch(r); break;
    case 'ev': if (r && r.state === 'play' && Array.isArray(m.e) && m.e.length <= 12 && m.e.every(v => typeof v === 'number' && isFinite(v))) { const d = m.e[2], sl = d >= 0 && d < SLOTS ? r.slots[d] : null; if (sl && sl.owner === c) bcast(r, { t: 'ev', e: m.e }, c); } break;   // only the victim's owner may report a hit
    case 'kill': if (r && r.state === 'play') {
      const v = clampInt(m.v, 0, SLOTS - 1, -1), k = clampInt(m.k, 0, SLOTS - 1, -1); if (v < 0 || !r.slots[v] || r.slots[v].owner !== c) break;
      if (r.set.mode === 2) { if (r.dead[v]) break; r.dead[v] = 1; }
      r.deaths[v]++; if (k >= 0 && k !== v && r.slots[k]) r.kills[k]++;
      bcast(r, { t: 'kill', v, k: k >= 0 && r.slots[k] ? k : -1 });
      if (r.set.mode === 2) checkLast(r);
    } break;
    case 'ping': c.ping = clampInt(m.rtt, 0, 9999, c.ping); send(c, { t: 'pong', ts: m.ts }); break;
  }
}

/* ------------------------- relay + housekeeping ------------------------- */
let tickN = 0; const out = Buffer.alloc(2 + SLOTS * REC);
setInterval(() => {                                                   // big lobbies: one batched frame per client, 30 times a second
  tickN++;
  for (const r of rooms.values()) {
    if (r.state !== 'play' || r.conns.size <= 8) continue;
    if (tickN % 2) continue;
    let n = 0, o = 2; for (let i = 0; i < SLOTS; i++) if (r.has[i] && r.slots[i]) { r.states.copy(out, o, i * REC, i * REC + REC); o += REC; n++; }
    if (!n) continue; out[0] = 1; out[1] = n; const f = frame(2, out.subarray(0, o));
    for (const c of r.conns) rawSend(c, f, true);
  }
}, 1000 / 60);
setInterval(() => { const now = Date.now(); for (const c of conns) { if (now - c.last > 45000) drop(c); else rawSend(c, frame(9, Buffer.alloc(0))); } }, 15000);

server.listen(PORT, HOST, () => log(`EMBER BLADES server on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (WebSocket on the same port)`));
process.on('uncaughtException', e => log('uncaught', e.stack || e));
