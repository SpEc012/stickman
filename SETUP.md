# Putting the game on stickmanbattle.online

Two things have to be live. Each is a one-time setup; after that every push to this repository updates both by itself.

| Piece | What it is | Where it runs | Address |
|---|---|---|---|
| The page | `index.html`, images | GitHub Pages | `https://stickmanbattle.online` |
| The game server | lobbies and online matches | Cloudflare Workers | `wss://play.stickmanbattle.online` |

The game already knows the server's address, so players never type anything — opening **Online Brawl** connects by itself and keeps retrying until the server answers.

You said the Cloudflare nameservers are already set at Namecheap. In the Cloudflare dashboard the domain should say **Active** before you go on (this can take from minutes to a few hours).

---

## Step 1 — Point the domain at the page (GitHub Pages)

**In Cloudflare** → your domain → **DNS → Records**, add these. Set every one to **DNS only** (grey cloud), not Proxied — GitHub needs that to issue the HTTPS certificate.

| Type | Name | Content |
|---|---|---|
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| CNAME | `www` | `spec012.github.io` |

Delete any other `A`, `AAAA` or `CNAME` records for `@` or `www` that Namecheap or Cloudflare created (parking pages).

**In GitHub** → this repository → **Settings → Pages**:

1. Under **Custom domain** type `stickmanbattle.online` and press **Save**.
2. Wait for the DNS check to turn green (a few minutes, sometimes longer).
3. Tick **Enforce HTTPS** once it becomes available.

Check: `https://stickmanbattle.online` shows the game. Story, Versus, Mass Brawl and Training all work at this point; only Online Brawl still says "retrying".

---

## Step 2 — Put the game server on Cloudflare

Pick **one** of the two ways.

### Way A — let GitHub deploy it (no software to install)

1. **Cloudflare dashboard** → profile icon (top right) → **My Profile → API Tokens → Create Token**.
2. Choose the template **Edit Cloudflare Workers** → **Continue to summary** → **Create Token**. Copy the token (it is shown once).
   - Under *Account Resources* pick your account; under *Zone Resources* pick **All zones** (or just `stickmanbattle.online`).
3. **GitHub** → this repository → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `CLOUDFLARE_API_TOKEN`
   - Secret: the token you copied
4. **GitHub** → **Actions** tab → **Deploy game server to Cloudflare** → **Run workflow**.

After about a minute the run turns green. From then on the server redeploys by itself whenever its files change.

If the run fails:

- *Authentication / permission error mentioning the domain or DNS* — edit the token and add the permission **Zone → DNS → Edit** for `stickmanbattle.online`, then run the workflow again.
- *More than one account* — also add a secret `CLOUDFLARE_ACCOUNT_ID` (Cloudflare dashboard → Workers & Pages → the Account ID shown on the right).
- *Domain not active* — the nameserver change has not finished yet; try again later.

### Way B — from your own computer

Needs [Node.js](https://nodejs.org) installed. Download this repository, open a terminal in its folder, then:

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

The first command opens the browser to log in to Cloudflare; the second uploads the server.

---

## Step 3 — Check it

1. Open `https://play.stickmanbattle.online/health` — it should show something like `{"ok":true,"rooms":0,"players":0}`.
2. Open `https://stickmanbattle.online`, choose **Online Brawl**. The top line should say **ONLINE** with a ping.
3. Press **Create Lobby**, then open the site on a second device or browser window and **Quick Join** (or type the four-letter code).

That's it.

---

## Good to know

- **What happens when you push changes.** The page redeploys through *Deploy static content to Pages*; the server redeploys through *Deploy game server to Cloudflare* (only when `hub.mjs`, `worker.mjs` or `wrangler.toml` change). A server redeploy disconnects everyone who is playing online; they reconnect by themselves to empty lobbies.
- **Cloudflare usage.** Every message a player's browser sends counts towards your Workers / Durable Objects allowance, and each player sends about 30 small messages a second while fighting. Look at Cloudflare's current limits for your plan before a big launch; the dashboard (Workers & Pages → stickman-battle-server → Metrics) shows what you are using.
- **Share image.** Link previews on X, Discord and others use `https://stickmanbattle.online/og.jpg`, so they only appear once Step 1 is done. X caches previews; if an old one sticks, add `?v=2` to the link you post.
- **Changing the address.** The server name lives in two places that must match: `SERVER_URL` near the top of the script in `index.html`, and `routes` in `wrangler.toml`.
- **Not using Cloudflare for the server?** `node server.js` on any Node host works too (see the README); set `SERVER_URL` to that host's `wss://` address.
- **Testing on your own machine.** `node server.js`, then open `http://localhost:8080` — the page uses the local server automatically.

This setup was written from the configuration and tested with Cloudflare's local runtime; it has not been run against your Cloudflare or GitHub accounts, so if a screen looks different from these steps, the names above (API Tokens, Custom domain, Secrets) are what to look for.
