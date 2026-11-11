/* =====================================================================
   EMBER BLADES — lobby + relay logic.

   Pure JavaScript with no platform APIs, shared by both ways of hosting:
     server.js   (Node:        `node server.js`)
     worker.mjs  (Cloudflare:  `npx wrangler deploy`)

   What it does: lobbies (create / list / join by code / quick join, host settings,
   host migration), relays 20-byte fighter records and combat events during a match,
   counts kills, runs the clock and decides the winner.

   What it does NOT do: simulate the fight. Each client simulates the fighters it
   owns and decides the hits that land on them; the hub only checks that a client
   writes to slots it owns. That keeps latency low and the server tiny, and it
   means a modified client could cheat — fine for playing with friends.

   A transport gives each connection an `io` object:
     io.text(string)   io.bin(Uint8Array)   io.buffered() -> bytes queued   io.close()
   and calls hub.connect(io), hub.message(conn, data), hub.drop(conn).
   ===================================================================== */
export const REC = 20, SLOTS = 64, MAX_FIGHTERS = 50, MAX_ROOMS = 300, MAX_CONNS = 2000, MAX_MSG = 16384;
const N_MAPS = 6, TIMES = [120, 180, 300, 480], FILL = [2, 4, 6, 8, 12, 16, 24, 32, 40, 50], INTRO_MS = 1750, END_MS = 9000;
const BOT_NAMES = ['ASH', 'VEX', 'NOVA', 'RIFT', 'KAEL', 'ONYX', 'PYRE', 'ZEN', 'MOTH', 'DUSK', 'IRIS', 'JINX', 'LYNX', 'ORCA', 'RUNE', 'SOOT', 'TALON', 'UMBRA', 'WISP', 'XAN', 'YARA', 'ZEPH', 'BLAZE', 'CROW', 'DRIFT', 'ECHO', 'FANG', 'GLINT', 'HEX', 'IVO', 'JADE', 'KITE', 'LUX', 'MIRE', 'NYX', 'OPAL', 'PIKE', 'QUILL', 'REED', 'SLATE', 'THORN', 'ULRIC', 'VALE', 'WREN', 'XYLA', 'YEW', 'ZARA', 'BRAND', 'CINDER', 'DART'];
const COLS = ['blue', 'red', 'green', 'purple', 'yellow', 'orange', 'white'];
const clampInt = (v, lo, hi, d) => { v = Math.floor(+v); return v >= lo && v <= hi ? v : d; };
const cleanName = (s, d, max) => { s = String(s || '').replace(/[^\w \-.!?']/g, '').trim().slice(0, max || 14).toUpperCase(); return s || d; };
const rint = n => Math.floor(Math.random() * n);

export function createHub(opt = {}) {
  const log = opt.log || (() => { });
  const rooms = new Map(), conns = new Set();
  let nextId = 1, tickN = 0, timer = null;
  const out = new Uint8Array(2 + SLOTS * REC);

  /* ------------------------------ sending ------------------------------ */
  const send = (c, obj) => { if (c.alive) c.io.text(JSON.stringify(obj)); };
  const sendBin = (c, u8) => { if (c.alive && c.io.buffered() < 262144) c.io.bin(u8); };        // a slow client skips state frames instead of queueing them
  const bcast = (r, obj, except) => { const s = JSON.stringify(obj); for (const c of r.conns) if (c !== except && c.alive) c.io.text(s); };

  /* ------------------------------- rooms ------------------------------- */
  const humans = r => r.conns.size;
  function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (; ;) { let s = ''; for (let i = 0; i < 4; i++) s += A[rint(A.length)]; if (!rooms.has(s)) return s; } }
  function roomInfo(r) {
    return { t: 'room', code: r.code, name: r.name, host: r.host.id, set: r.set, state: r.state, priv: r.priv,
      players: [...r.conns].map(c => ({ id: c.id, name: c.name, look: c.look, col: c.col, slot: c.slot, team: r.slots[c.slot] ? r.slots[c.slot].team : 0, ping: c.ping })) };
  }
  function sendRoom(r) { const info = roomInfo(r); for (const c of r.conns) send(c, Object.assign({ you: c.id, slot: c.slot }, info)); }
  function lobbyList() {
    const list = [];
    for (const r of rooms.values()) { if (r.priv) continue; list.push({ code: r.code, name: r.name, n: humans(r), max: MAX_FIGHTERS, map: r.set.map, mode: r.set.mode, state: r.state }); if (list.length >= 60) break; }
    return list;
  }
  function freeSlot(r) { for (let i = 0; i < MAX_FIGHTERS; i++) if (!r.slots[i]) return i; return -1; }
  function fighters(r) { let n = 0; for (let i = 0; i < SLOTS; i++) if (r.slots[i]) n++; return n; }
  function teamFor(r) { let a = 0, b = 0; for (const s of r.slots) if (s) { if (s.team === 1) a++; else if (s.team === 2) b++; } return a <= b ? 1 : 2; }
  function entry(r, i) { const s = r.slots[i]; return { slot: i, name: s.name, look: s.look, col: s.col, team: s.team, owner: s.owner.id, bot: s.bot }; }
  function createRoom(c, m) {
    if (rooms.size >= MAX_ROOMS) return send(c, { t: 'err', msg: 'The server is full. Try again later.' });
    leaveRoom(c);
    const r = { code: newCode(), name: cleanName(m.name, c.name + "'S LOBBY", 24), host: c, priv: !!m.priv, conns: new Set(), slots: new Array(SLOTS).fill(null), set: { map: 1, mode: 0, time: 2, fill: 3, tier: 2 }, state: 'lobby',
      states: new Uint8Array(SLOTS * REC), has: new Uint8Array(SLOTS), kills: new Int16Array(SLOTS), deaths: new Int16Array(SLOTS), dead: new Uint8Array(SLOTS), seed: 1, startAt: 0, timer: null };
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
    const bot = () => ({ owner: r.host, bot: true, name: BOT_NAMES[bi % BOT_NAMES.length], look: (bi * 7 + 1) % 5, col: COLS[(bi * 3 + 1) % COLS.length], team: (n % 2) + 1 });
    for (let i = SLOTS - 1; i >= MAX_FIGHTERS && n < total; i--, n++, bi++) r.slots[i] = bot();
    for (let i = 0; n < total && i < MAX_FIGHTERS; i++) if (!r.slots[i]) { r.slots[i] = bot(); n++; bi++; }
    r.seed = 1 + rint(0xfffffe); r.state = 'play'; r.startAt = Date.now();
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
    r.timer = setTimeout(() => { if (rooms.get(r.code) !== r) return; r.state = 'lobby'; for (let i = 0; i < SLOTS; i++) if (r.slots[i] && r.slots[i].bot) r.slots[i] = null; sendRoom(r); }, END_MS);
  }

  /* ------------------------------ messages ------------------------------ */
  function onBinary(c, data) {                                          // fighter records: [1][count][count * 20 bytes]
    const r = c.room; if (!r || r.state !== 'play' || data.length < 2 || data[0] !== 1) return;
    const n = data[1]; if (data.length !== 2 + n * REC) return;
    let ok = 0, w = 2;                                                  // keep only records for slots this client owns
    for (let i = 0, o = 2; i < n; i++, o += REC) {
      const s = data[o], sl = s < SLOTS ? r.slots[s] : null; if (!sl || sl.owner !== c) continue;
      r.states.set(data.subarray(o, o + REC), s * REC); r.has[s] = 1; if (w !== o) data.copyWithin(w, o, o + REC); w += REC; ok++;
    }
    if (ok && r.conns.size <= 8) { data[1] = ok; const f = data.subarray(0, w); for (const o of r.conns) if (o !== c) sendBin(o, f); }   // small lobbies: forward at once
  }
  function onJson(c, m) {
    const r = c.room;
    switch (m.t) {
      case 'hello': c.name = cleanName(m.name, 'PLAYER' + (c.id % 100)); c.look = clampInt(m.look, 0, 4, 0); c.col = COLS.includes(m.col) ? m.col : 'blue'; if (r && r.state === 'lobby' && r.slots[c.slot]) { const s = r.slots[c.slot]; s.name = c.name; s.look = c.look; s.col = c.col; sendRoom(r); } break;
      case 'list': send(c, { t: 'lobbies', list: lobbyList() }); break;
      case 'create': createRoom(c, m); break;
      case 'join': { const rr = rooms.get(String(m.code || '').toUpperCase().trim()); if (!rr) return send(c, { t: 'err', msg: 'No lobby with that code.' }); joinRoom(c, rr); break; }
      case 'quick': { let best = null; for (const rr of rooms.values()) if (!rr.priv && humans(rr) < MAX_FIGHTERS && (!best || humans(rr) > humans(best))) best = rr; if (best) joinRoom(c, best); else createRoom(c, { name: '' }); break; }
      case 'leave': leaveRoom(c); send(c, { t: 'left' }); break;
      case 'me': if (r) { c.look = clampInt(m.look, 0, 4, c.look); if (COLS.includes(m.col)) c.col = m.col; const s = r.slots[c.slot]; if (s && r.state === 'lobby') { s.look = c.look; s.col = c.col; } sendRoom(r); } break;
      case 'set': if (r && r.host === c && r.state === 'lobby' && m.set) { const s = m.set, o = r.set; o.map = clampInt(s.map, 0, N_MAPS - 1, o.map); o.mode = clampInt(s.mode, 0, 2, o.mode); o.time = clampInt(s.time, 0, TIMES.length - 1, o.time); o.fill = clampInt(s.fill, 0, FILL.length - 1, o.fill); o.tier = clampInt(s.tier, 0, 4, o.tier); if (typeof m.priv === 'boolean') r.priv = m.priv; sendRoom(r); } break;
      case 'start': if (r && r.host === c && r.state === 'lobby') startMatch(r); break;
      case 'ev':                                                        // only the victim's owner may report a hit
        if (r && r.state === 'play' && Array.isArray(m.e) && m.e.length <= 12 && m.e.every(v => typeof v === 'number' && isFinite(v))) { const d = m.e[2], sl = d >= 0 && d < SLOTS ? r.slots[d] : null; if (sl && sl.owner === c) bcast(r, { t: 'ev', e: m.e }, c); }
        break;
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

  /* ------------------------ relay + housekeeping ------------------------ */
  function tick() {                                                     // big lobbies: one batched frame per client, 30 times a second
    tickN++;
    if (tickN % 2 === 0) for (const r of rooms.values()) {
      if (r.state !== 'play' || r.conns.size <= 8) continue;
      let n = 0, o = 2; for (let i = 0; i < SLOTS; i++) if (r.has[i] && r.slots[i]) { out.set(r.states.subarray(i * REC, i * REC + REC), o); o += REC; n++; }
      if (!n) continue; out[0] = 1; out[1] = n; const f = out.subarray(0, o);
      for (const c of r.conns) sendBin(c, f);
    }
    if (tickN % 900 === 0) { const now = Date.now(); for (const c of [...conns]) if (now - c.last > 45000) drop(c); }   // silent connections
  }
  function drop(c) {
    if (!c.alive) return; c.alive = false; conns.delete(c);
    try { leaveRoom(c); } catch (e) { log('leave error', e.message); }
    try { c.io.close(); } catch (e) { /* already gone */ }
    if (!conns.size && timer) { clearInterval(timer); timer = null; }
  }

  return {
    // a new connection; returns the handle to pass to message() and drop(), or null when the server is full
    connect(io) {
      if (conns.size >= MAX_CONNS) { try { io.close(); } catch (e) { /* ignore */ } return null; }
      const c = { io, id: nextId++, name: 'PLAYER', look: 0, col: 'blue', room: null, slot: -1, n: 0, nT: Date.now(), ping: 0, alive: true, last: Date.now() };
      conns.add(c); if (!timer) timer = setInterval(tick, 1000 / 60);
      send(c, { t: 'welcome', id: c.id });
      return c;
    },
    // data: a string (JSON) or bytes (Uint8Array / ArrayBuffer)
    message(c, data) {
      if (!c || !c.alive) return;
      const now = Date.now(); c.last = now;
      if (now - c.nT > 1000) { c.nT = now; c.n = 0; } if (++c.n > 400) return drop(c);       // flood
      try {
        if (typeof data === 'string') { if (data.length > MAX_MSG) return drop(c); let m; try { m = JSON.parse(data); } catch (e) { return; } if (m && typeof m === 'object') onJson(c, m); }
        else { const u8 = data instanceof Uint8Array ? data : new Uint8Array(data); if (u8.length > MAX_MSG) return drop(c); onBinary(c, u8); }
      } catch (e) { log('message error', e.message); }
    },
    drop,
    health() { return { ok: true, rooms: rooms.size, players: conns.size }; }
  };
}
