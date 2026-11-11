# EMBER BLADES — Stickman Saber Battles

A fast 2D stickman saber fighter on a volcanic world: story duels, local versus, mass brawls against bots, and **online lobbies for up to 50 fighters**.

- The whole game is one file, `index.html` — Canvas 2D and WebAudio, no assets, no libraries, no build step.
- Online play needs the game server running somewhere. It has no dependencies and comes in two forms that share the same logic (`hub.mjs`): `server.js` for Node, and `worker.mjs` for Cloudflare Workers.

## Play

- **Offline (everything except online lobbies):** open `index.html`.
- **With online lobbies, on your own machine:**

```bash
node server.js
```

Then open `http://localhost:8080`. Other people on your network can join at `http://<your-ip>:8080`.

## Putting it on the internet

**Step-by-step instructions for stickmanbattle.online are in [SETUP.md](SETUP.md).** In short:

- **The page** (`index.html`, `og.jpg`, icons) is static and is deployed by GitHub Pages on every push.
- **The game server** runs on Cloudflare Workers at `wss://play.stickmanbattle.online` (`worker.mjs`, configured by `wrangler.toml`), deployed by the *Deploy game server to Cloudflare* workflow once a `CLOUDFLARE_API_TOKEN` secret exists — or by hand with `npx wrangler deploy`.
- **Players never enter an address.** The game connects to `SERVER_URL` (near the top of the script in `index.html`) by itself and keeps retrying until the server answers. `?server=wss://…` overrides it for testing.

Prefer a normal server? Any Node host works (Node 18+, nothing to install, listens on `PORT`, default 8080):

```bash
node server.js
```

`server.js` also serves the page, share image and icons, and `GET /health` returns the number of open lobbies and connected players. Opened from the machine running it (`http://localhost:8080`), the page uses that local server automatically. Otherwise set `SERVER_URL` to the host's `wss://` address.

### How online play works (and its limits)

- Each player's browser simulates its own fighter, so your own movement has no network delay. The host's browser also simulates the bots.
- A hit is decided by the **defender's** browser, using what that player saw — so blocks and perfect parries are judged fairly for the person doing them. The attacker sees the result one round trip later.
- The server relays positions and events, checks that nobody writes to a fighter they don't own, counts kills, runs the clock and names the winner. If the host leaves, the next player inherits the lobby and its bots.
- The server does not simulate the fight, so a modified client could cheat (for example by ignoring hits). Fine among friends; a public competitive ladder would need server-side simulation.
- Up to 8 players, positions are forwarded the instant they arrive; larger lobbies are batched 30 times a second.

## Modes

- **Story Duel** — five opponents, best of three each, Initiate to Grandmaster. The last three are bosses with their own moves. Winning unlocks three more duellists.
- **Online Brawl** — create a public or private lobby, share its four-letter code, or quick-join. The host picks the map, mode, time and how many bots fill the empty places. People can join a match in progress.
- **Mass Brawl** — the same battles offline: you and up to 49 bots.
- **Versus** — two players on one keyboard, or keyboard + gamepads.
- **Training** — dummy behaviours, frame data for your last move, hitbox view, infinite meters.

Brawl rules: **Free For All** (most kills when time runs out), **Team Battle** (blue vs red), **Last One Standing** (no respawns).

## Maps

Duel arenas: Lava Plains (geysers), Bridge of Ash (collapsing ends, ring-outs), Obsidian Temple (rain, mirror floor), Aurora Glacier (snow, aurora, frost vents).

Brawl maps have one-way platforms on two levels, and some have pits:

| Map | Size | Notes |
|---|---|---|
| The Pit | small | three platforms, for a handful of fighters |
| Ashen Causeway | medium | bridge with two pits |
| Caldera | large | eight platforms over the lava plain |
| Shattered Span | large | long bridge broken by four pits — falls are ring-outs |
| Storm Temple | large | balconies in the rain |
| Aurora Glacier | huge | the widest map |

## Controls

| Action | Player 1 | Player 2 | Gamepad |
|---|---|---|---|
| Move | A / D | ← / → | stick or d-pad |
| Jump · Crouch | W · S | ↑ · ↓ | A or up · down |
| Light slash | J | Numpad 1 or 7 | X |
| Heavy slash | K | Numpad 2 or 8 | Y |
| Force power | L | Numpad 3 or 9 | B |
| Dash | U | Numpad 4 or 0 | RT |
| Block / parry | I | Numpad 5 or - | RB |
| Ultimate | O | Numpad 6 or = | LB |

**Mouse:** left click = light, right click = heavy. With *Free saber* switched on (see below) the blade also follows the pointer. Left-hand keys for mouse play: `Space` jump, `Q` force, `E` block, `Shift` dash, `X` ultimate.

`Esc` pause/menu · `Tab` scoreboard (brawls) · `M` mute · `F` fullscreen · `F1` debug overlay · Training: `T` dummy, `H` hitboxes, `R` reset.
Touch buttons appear automatically on touch screens.

### Controllers

Any controller the browser's Gamepad API sees works; plug it in and press a button. *Options → Controller* has:

- **Rebinding** — pick an action, press the button you want. Three presets (Classic, Triggers, Fighter) or your own layout, saved per player.
- **A live tester** — a drawing of the pad that lights up as you press, with the right button names for Xbox, PlayStation and Switch pads. On-screen prompts everywhere switch to those names the moment you touch the controller, and back when you touch the keyboard.
- **Vibration** — off, low or full. Hits, blocks, parries, clashes, wall slams, ultimates and KOs each feel different. (Phones buzz instead.)
- **Stick deadzone**, whether stick-up jumps, and whether the right stick aims the saber or flick-dashes.
- **Versus** — two controllers are player 1 and player 2; with one controller you choose which player gets it.

Menus are fully drivable from the pad (d-pad or stick, bottom button confirms, right button goes back, held directions repeat), there is an on-screen keyboard for your name and for lobby codes, `View/Share` shows the scoreboard, and unplugging the pad pauses an offline fight. Unusual pads that don't report the standard layout still move through their hat or axes and can simply be rebound.

### Free saber (mouse or right stick)

**Off by default.** Turn it on in *Options → Free saber aim* (or set the right stick to "aims the saber" in *Options → Controller*). Then move the mouse — or tilt the right stick — and the blade follows it on a spring, turning your fighter to face that side.

- **Cut:** swing the blade through an enemy. Damage (3 to 9) grows with how far and how fast you swung; tiny wiggles do nothing. One sweep can hit several enemies in a brawl. Two swinging blades that meet clash.
- **Guard:** hold the blade still between you and the attacker and it blocks — raised for overheads, lowered for sweeps. Flick it into place just before the hit and it is a perfect parry.
- Button attacks, throws, Force powers and ultimates all still work alongside it.
- While it is off, the right stick flick-dashes instead, and the mouse buttons still attack.


## Moves

| Input | Move |
|---|---|
| J, J, J | Three-hit combo; the third hit sends them flying |
| K | Overhead smash — block it standing; bounces them off the floor |
| K, K (on hit) or S + K | Rising launcher |
| S + J | Low sweep — block it crouching (S + I) |
| J / K in the air | Air slash / somersault slash |
| U, then J | Dash attack |
| back + U · U in the air | Backstep (invulnerable start) · air dash |
| S + W | Drop through a platform |
| I + J | Throw — beats block |
| I + K | Guard break — unblockable, 35 Focus |
| L · S + L · forward + L (hold) | Force push · pull · lightning |

### Ultimates (full Focus)

Directions are relative to the way you face; press them one after the other, then O.

| Input | Ultimate |
|---|---|
| O | **Duel of Fates** — five dash-through cuts and a rising finisher |
| ↓, forward, O | **Stormbreaker** — lift them with the Force, call down six bolts, hurl them into the floor |
| ↓, ↓, O | **Skyfall** — launch them skyward, three somersault dives, ride them into the ground |
| back, forward, O | **Thousand Cuts** — a planted twelve-slash flurry and a crushing last blow |

A whiffed or blocked ultimate costs half the bar.

### Finishers

In Story and Versus, the blow that would win the match leaves the loser dazed instead: **END IT!** Any hit ends the match — or stand near them and use a combination:

| Input | Finisher |
|---|---|
| ↓, ↓, J | **Cinderfall** — one cut; they scatter into embers |
| back, forward, K | **Skyward Exile** — hurled over the horizon |
| ↓, forward, L | **Judgement Bolt** — the sky answers |

### Defence

- **Block** (hold I): chip damage only, but it drains the guard bar; empty guard = guard crush.
- **Perfect parry**: tap I within about 100 ms before impact. The attacker staggers and you gain Focus. It also reflects lightning.
- **Saber lock**: three quick clashes (duels only) — mash J / K.
- After a knockdown, hold a direction to roll as you get up.

## Graphics and frame rate

*Options → Graphics & Frame Rate*:

- **Quality** — auto (steps down if the frame rate dips), low, medium, high, ultra (finer bloom, more particles).
- **Resolution scale** — 50 % to 200 % (above 100 % is supersampling).
- **Frame rate** — VSync, a cap from 30 to 360, or uncapped. Above your display's refresh rate the extra frames only reduce input delay and cost a lot of power.
- FPS counter and scanlines.

The simulation always runs at a fixed 60 ticks per second and the picture is interpolated, so motion stays smooth at 120, 144 or 240 Hz.

## What has and has not been tested

Everything was tested in headless Chromium on a machine without a GPU:

- Full story runs, all arenas and maps, 50-fighter brawls, all four ultimates and three finishers, touch input — no console errors.
- **Controllers:** 36 checks with simulated Xbox, PlayStation, Switch and non-standard pads (menus, rebinding, presets, rumble calls, stick aiming, hot-plug, versus assignment), plus creating a name and joining a lobby with a controller alone.
- **Free saber:** sweeps, wiggles, blade guard and flick-parry timing against three attack types; replicated to a second client.
- **Online:** lobbies, joining by code, late joining, hits / blocks / kills across two and three real browser clients, a 50-fighter match, host migration, and a 50-connection load test — against both the Node server and the Cloudflare Worker (in Cloudflare's local runtime).

Not tested:

- **Real controllers and real rumble.** Everything above used simulated devices; no physical pad has been held, so feel (deadzones, rumble strength, stick aiming) is untuned by hand.
- **A live Cloudflare deployment** and **real network conditions** (latency, packet loss). All online tests ran on one machine.
- **Real hardware frame rates.** Without a GPU the game does not reach 60 FPS at full quality here.
- **Audio** has never been listened to, and no physical phone, Safari or Firefox was used.

`DESIGN.md` has the architecture, the netcode, the frame data and the AI tiers.
