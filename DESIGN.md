# EMBER BLADES — design doc

A single-file (`index.html`) 2D stickman saber fighter, plus `server.js` (lobbies and relay, no dependencies) for online play. Canvas 2D + WebAudio, no assets, no libraries.

## Architecture

| Section | Responsibility |
|---|---|
| **Core** | Fixed 60 Hz simulation (`simStep`) fed by an accumulator scaled by `timeScale` (slow-mo). Rendering interpolates every frame with `alpha`, including *animation time*, so slow-mo and 120 Hz displays stay smooth. Seeded RNG for the sim. |
| **Input** | Keyboard, Gamepad API and touch buttons all write into a `Pad` (held bits + 7-frame press buffer). The AI writes into the same `Pad`, so fighters never know who drives them. |
| **Camera** | Tracks the midpoint with look-ahead, zooms in when fighters are close and out when apart, trauma-based shake, tilt, zoom punch, cinematic focus override. |
| **Physics / Collision** | Point-mass fighter bodies (gravity, friction, push-boxes, wall bounce, ring-out). Per-frame AABB hitboxes from move data vs. state-dependent hurtboxes. |
| **Animation** | 16-channel pose (pelvis, lean, hand target, blade angle, foot targets, rotation, squash) → 2-bone IK for both arms and legs → 15 joints. Keyframed clips with easing/overshoot, snapshot cross-fades, procedural walk cycle (distance-driven so feet plant), breathing, landing squash. |
| **Physics toys** | Verlet ragdoll (launches, knockdowns, KOs) pinned to the gameplay point mass, verlet cape chain, spark particles with gravity + floor bounce, bridge debris. |
| **Fighter** | State machine below; meters (HP, Focus, Force, Guard); swept-blade trail ring buffer sampled at 3 sub-steps per tick. |
| **Combat** | Hit / block / perfect parry / clash / saber-lock / throw / guard-break / force powers / ultimate cinematic, hit-stop, combo scaling, juggle limit. |
| **AI** | Utility scoring over ~14 actions + reaction queue (delay per tier) + habit tracker of the player's last 24 actions; boss-only moves. |
| **VFX** | Object-pooled sparks, dust, rings, flares, domes, ghosts, pop text, lightning (midpoint displacement), speed lines, embers, rain. |
| **Renderer** | Cached tileable parallax layers, animated perspective lava floor, wavy additive reflections, heat haze, layered additive blades, saber light pools, thresholded bloom, chromatic pulse, vignette, grain, scanlines. Dynamic quality scaler. |
| **Audio** | Procedural WebAudio: saber hum (pitch follows swing speed), whoosh, clash, parry chime, lightning crackle, thuds, steps, lava rumble, generative score (drone, taiko, choir pad, ostinato) driven by fight intensity. |
| **Brawl** | Any number of fighters (cap 50) on wide maps with one-way platforms and pits. Per-fighter targets, per-fighter hit-freeze instead of global hit-stop, deterministic hazard schedule from the match seed, respawns, three rule sets, bot navigation (pit jumping, platform use). |
| **Network** | WebSocket client for `server.js`: JSON for lobby / roster / events, 18-byte binary records for fighter state. |
| **UI / Flow** | Title (attract-mode duel) → menu → select → VS card → round intro → fight → KO → results. Pause, options, controls, training tools, F1 debug overlay. |

## Fighter state machine

```
            +--------- hit ---------> HIT ----(stun over)----+
            |                                                v
 INTRO -> STAND <-> CROUCH      LAUNCH -> DOWN -> GETUP -> STAND
            |  \-> JUMP -> (land)   ^ (launcher / air hit / push / KO)
            |-> DASH / BACKDASH     |
            |-> ATK (startup > active > recovery, cancel windows)
            |-> BLOCK (parry window 6f on press) -> blockstun / PARRY
            |-> CAST (push, pull, lightning, storm)
            |-> STAGGER (parried, guard crushed, lock lost, pulled)
            |-> LOCK (saber-lock mash)   ULT / ULTV (cinematic)
            |-> THROW -> victim THROWN -> LAUNCH
            +-> WIN / DEAD
```

## Frame data (60 fps)

| Move | Input | Startup | Active | Total | Dmg | Hitstun | Blockstun | Guard dmg | Level | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Light 1 | J | 6 | 3 | 22 | 6 | 17 | 11 | 7 | mid | cancels → Light 2 |
| Light 2 | J,J | 7 | 3 | 25 | 7 | 18 | 12 | 8 | mid | cancels → Light 3 |
| Light 3 | J,J,J | 9 | 4 | 36 | 10 | launch | 15 | 12 | mid | sends the target flying, special-cancel |
| Heavy overhead | K | 16 | 4 | 46 | 16 | floor bounce | 20 | 24 | high | cancels on hit → Rising launcher |
| Rising launcher | S+K or K,K | 13 | 4 | 44 | 13 | launch | 18 | 16 | mid | launches for juggles |
| Low sweep | S+J | 9 | 4 | 32 | 8 | trip | 12 | 8 | low | knockdown |
| Air slash | J (air) | 7 | 7 | — | 9 | 20 | 13 | 8 | high | |
| Somersault slash | K (air) | 10 | 9 | — | 13 | 24 | 16 | 14 | high | |
| Dash attack | U then J/K | 8 | 5 | 34 | 12 | launch | 16 | 14 | mid | afterimages |
| Throw | I+J | 5 | 2 | 30 | 12 | launch | — | — | — | beats block |
| Guard break | I+K | 20 | 4 | 52 | 10 | 30 | crush | — | — | 35 Focus, unblockable |
| Force push | L | 11 | 1 | 34 | 7 | launch | — | 10 | — | 30 Force |
| Force pull | S+L | 12 | 1 | 30 | 0 | stagger | — | 6 | — | 22 Force |
| Lightning | →+L (hold) | 14 | ≤70 | +16 | 0.45/f | — | — | drains | — | 25 Force + 0.5/f, parry reflects |
| Duel of Fates | O | 12 | 6 | 50 | ~40 | cinematic | 24 | 20 | mid | 100 Focus (50 if it whiffs) |

Perfect parry: block pressed ≤ 6 frames (100 ms) before impact. Block = 10 % chip. Guard bar empties → guard crush.
Three clashes in quick succession (or heavy vs heavy) → saber lock (9 s cooldown).

## AI tiers

| Tier | Reaction (frames) | Parry | Block | Aggression | Combo accuracy | Story damage |
|---|---|---|---|---|---|---|
| Initiate | 24 | 3 % | 30 % | 0.32 | 0.40 | ×0.70 |
| Adept | 17 | 9 % | 48 % | 0.46 | 0.60 | ×0.85 |
| Knight | 12 | 18 % | 62 % | 0.58 | 0.78 | ×1.00 |
| Master | 8 | 30 % | 76 % | 0.70 | 0.90 | ×1.06 |
| Grandmaster | 5 | 42 % | 88 % | 0.82 | 1.00 | ×1.12 |

An AI that is standing ready at close range reacts 7 frames sooner (anticipation), and reads the 2nd/3rd hit of a string 4 frames sooner. Parry chance is for heavy moves; lights are parried at 45 % of that rate.


## Brawl and netcode

**Ownership.** Every fighter has exactly one owner: a player's client owns that player's fighter; the host's client also owns the bots. An owner runs the full simulation for its fighters. Everyone else sees a *proxy* rebuilt from state records.

**State record (20 bytes, 30 per second per fighter).** slot · x, y (1/8 px) · vx, vy · state · flags (facing, crouch, lightning, grounded, ragdoll, ring-out, invulnerable, alive) · animation id and frame · move id, move frame and a move sequence number · health · target slot · blade length and ultimate variant · alpha · free-aim blade angle · swing power. Proxies advance animation and move frames themselves between records and extrapolate position by velocity (up to 6 ticks), easing 45 % of the error per tick.

**Hits are decided by the defender's owner.** Each tick, for every fighter it owns, a client checks every enemy's active hitbox (data-driven boxes from the frame table, using the proxy's move frame; `pst < b && st >= a` so a skipped frame cannot hide an active window; one hit per attacker, move instance and hit index). It applies the outcome locally — hit, block, perfect parry, guard crush, clash, throw, ultimate — and sends a *result event*. Every client plays the effects; the attacker's owner applies the attacker-side consequences (hit confirm, stagger when parried, recoil, focus). Force push, pull and lightning work the same way from the caster's replicated cast frame and target.

Why this way round: blocking and parrying judge exactly what the defending player saw, and nobody is hit by something that missed on their screen. The cost is that the attacker's hit spark arrives one round trip late.

**Server (`hub.mjs`, hosted by `server.js` on Node or `worker.mjs` on Cloudflare Workers).** Lobbies (code, public list, quick join, host settings, host migration with bot hand-over), slot ownership checks on every record and event, kill counting, match clock, winner. Lobbies of up to 8 forward records immediately; larger ones are batched at 30 Hz. It does not simulate combat, so it is not cheat-proof.

**Ultimates and finishers.** One timeline function per ultimate variant, parameterised by which side(s) the client owns (`oa`, `od`): in a duel both, online one or neither (spectators still get the effects). Finishers are duel-only cinematics entered from the dazed state on match point.

**Crowd rendering.** Fighters outside the view are neither posed nor drawn. With more than 10 (and again more than 22) fighters in view, blade glow layers, light pools, reflections, trail density, name tags and bloom are reduced so additive glow does not wash the screen out and the draw cost stays bounded.

## Input

Keyboard, mouse, touch and any number of Gamepad-API controllers all end in the same `Pad` (ten buttons with a press buffer, plus an optional aim target). Controllers have per-player rebindable maps, presets, hat/axis fallbacks for non-standard pads, auto-repeating menu navigation, a capture mode for rebinding and haptics (`HAP(fighter, strong, weak, ms)` → `vibrationActuator.playEffect`, or `navigator.vibrate` on phones). `lastDev` tracks the device in use so prompts show the right key or button names.

## Free saber

When a `Pad` carries an aim (mouse world position or right-stick direction) and the fighter is in a neutral state, a damped spring (`v = 0.58 v + 0.34 Δ`) drives the blade angle towards it; the pose layer overrides hand target and blade angle and the fighter faces the aimed side. Swing power = 60 % arc swept in one direction (0.5 to 2.1 rad) + 40 % angular speed (0.12 to 0.42 rad/tick), zero below either floor. A cut lands when the blade segment — or the path its tip and middle travelled since the last tick — crosses a hurtbox, at most once per target every 26 ticks, and then goes through the same hit / block / parry resolution as any move (damage 3 + 6·power). A blade held nearly still (≤ 0.2 rad/tick) in front of the fighter guards; if it settled within the last 5 ticks the guard is a perfect parry. Online, the blade angle and swing power ride in the state record and cuts are decided by the defender's client like every other hit.
