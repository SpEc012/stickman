# EMBER BLADES — Stickman Saber Duel

A fast 2D stickman saber duel on a volcanic world. One file (`index.html`), no assets, no build step, no libraries: Canvas 2D for the picture, WebAudio for every sound.

**Play:** open `index.html` in a browser (or serve the folder and open it on a phone).

## Modes

- **Story Duel** — five opponents, best of three each, from Initiate to Grandmaster. The last three are bosses with their own moves (twin-blade spin, lightning storm, teleport dash). Winning unlocks three more duellists (green, purple, yellow blades).
- **Versus** — two players on one keyboard, or keyboard + gamepads.
- **Training** — a dummy you can set to stand, crouch, jump, block everything, parry everything or fight back; frame data for your last move; hitbox view; infinite meters.

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

`Esc` pause · `M` mute · `F1` debug overlay (hitboxes, states, FPS) · Training: `T` dummy, `H` hitboxes, `R` reset.
On touch screens the buttons appear on screen automatically. In single-player modes the arrow keys also move player 1.

## Moves

| Input | Move |
|---|---|
| J, J, J | Three-hit combo; the third hit sends the opponent flying |
| K | Overhead smash — must be blocked standing; bounces them off the floor |
| K, K (on hit) or S + K | Rising launcher — juggle afterwards |
| S + J | Low sweep — must be blocked crouching (S + I) |
| J / K in the air | Air slash / somersault slash |
| U, then J | Dash attack with afterimages |
| back + U | Backstep, invulnerable at the start |
| U in the air | Air dash |
| I + J | Throw — beats a blocking opponent |
| I + K | Guard break — unblockable, costs 35 Focus |
| L | Force push — hurls them across the stage (wall slams hurt) |
| S + L | Force pull — drags them into range, staggered |
| forward + L (hold) | Lightning — damage over time while held |
| O | **Duel of Fates** — cinematic multi-slash ultimate, needs full Focus |

### Defence

- **Block** (hold I): 10 % chip damage and it drains the thin guard bar; an empty guard bar means a guard crush.
- **Perfect parry**: tap I within about 100 ms before a hit lands. White flash, the attacker staggers, you gain Focus and can punish. A perfect parry also reflects lightning back at the caster.
- Blocking lightning spends your Force instead of your health.
- **Saber lock**: three clashes in quick succession (or two heavies meeting) lock the blades. Mash J / K to win a free hit.
- After a knockdown, hold left or right to roll as you get up.

### Meters

- **Health** (yellow), **Focus** (gold: built by landing hits, parrying and clashing; spent on guard breaks and the ultimate), **Force** (blue: regenerates, powers push / pull / lightning), **Guard** (thin white bar).

## Arenas

- **Lava Plains** — lava geysers erupt after a glowing telegraph.
- **Bridge of Ash** — rocks fall from above; slam someone into an end pylon twice and that end of the bridge collapses, after which a launch past the edge is a ring-out.
- **Obsidian Temple** — night, rain, mirror floor, plasma vents.

## Options

Volume, mute, quality (auto / high / medium / low — auto steps down if the frame rate dips), screen shake, scanlines, touch buttons. Settings and unlocks are saved in `localStorage`.

## Notes

- Tested in headless Chromium only: full story runs, all three arenas, touch and a simulated gamepad, with no console errors. It has not been run on a physical phone, a real gamepad, Safari or Firefox, and the audio has not been listened to.
- Frame rate was only measured with software rendering (no GPU), where full quality at 1280×720 does not hold 60 FPS and the auto quality setting steps down; on a machine with a GPU it should be far lighter, but that is not measured.
- `DESIGN.md` has the architecture, the fighter state machine, the frame data and the AI tier table.
