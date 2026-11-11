/* =====================================================================
   EMBER BLADES — game server for Cloudflare Workers.

   One Durable Object ("Hub") holds every lobby in memory and owns all WebSockets;
   the lobby / relay logic is the same hub.mjs that server.js uses on Node.

   Deploy:   npx wrangler deploy
   Then set SERVER_URL in index.html to   wss://<the address wrangler prints>

   Notes
   - While anyone is connected the object stays in memory, so lobbies and timers
     behave exactly like the Node server. When Cloudflare restarts it (for example
     after a deploy) every connection drops and players reconnect to empty lobbies.
   - Every WebSocket message counts towards the account's Durable Object usage.
   ===================================================================== */
import { createHub } from './hub.mjs';

export class Hub {
  constructor(state, env) { this.hub = createHub({ log: (...a) => console.log(...a) }); }
  async fetch(req) {
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket')
      return new Response(JSON.stringify(this.hub.health()), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    const pair = new WebSocketPair(), client = pair[0], ws = pair[1];
    ws.accept();
    let open = true;
    const io = {
      text: s => { if (open) try { ws.send(s); } catch (e) { open = false; } },
      bin: u8 => { if (open) try { ws.send(u8.slice()); } catch (e) { open = false; } },     // copy: the hub reuses its buffers
      buffered: () => 0,
      close: () => { if (open) { open = false; try { ws.close(1000, 'bye'); } catch (e) { /* already closed */ } } }
    };
    const conn = this.hub.connect(io);
    if (!conn) return new Response('server full', { status: 503 });
    ws.addEventListener('message', e => this.hub.message(conn, e.data));
    const gone = () => { open = false; this.hub.drop(conn); };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), ws = (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket';
    if (ws || url.pathname === '/health') return env.HUB.get(env.HUB.idFromName('hub')).fetch(req);
    return new Response('Ember Blades game server. The game connects here with a WebSocket.\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
};
