# Architecture

## Layout

```
apps/server      reads and checks the ROM, serves it and the client, WebSocket rooms (/ws)
apps/web         React client: loads the ROM, runs the game
packages/core    the game: 65816 -> JS translator, Machine, Game, the picture (ppu/), the sound unit (apu/)
packages/rules   game modes (Ruleset) and their overrides: classic, 2 vs 2 in the full arena
tools/oracle     emulator dumps (WRAM, CPU and sound state, picture, sound) and captured routine calls, for tests (needs ../ssm-disasm)
tools/           compare-frames.ts / compare-video.ts (game vs emulator), disasm.ts (ROM), check-core-purity.mjs
```

## The game (packages/core)

- **Translator** (`cpu/compile.ts`). It translates a basic block of ROM code to a JavaScript
  function the first time the block runs, using the M / X register widths the CPU has at that
  moment, and caches it by (address, M, X). Every instruction is decoded with its real
  widths, so no static analysis is needed.
- **Machine** (`cpu/machine.ts`) holds the 65816 registers, 128 KiB of WRAM and the ROM. It
  also models the CPU I/O the game uses: multiply / divide, the WRAM port, DMA, and joypads
  (auto-read and serial). A video sink records VRAM, CGRAM and OAM writes. The sound unit
  (`apu/`) is emulated, and the game uploads and runs its own driver on it. All state that a
  rollback restores lives in one buffer, the sound unit's included: `save()` / `load()`,
  `checksum()`.
- **Game** (`cpu/game.ts`): `powerOn()`, then `step(pads)` once per video frame. Execution is
  one stream, as on hardware: the main loop, with the video IRQ (C0023A) taken at the
  instruction boundary where its H/V timer falls. A frame ends at the first instruction
  boundary after line 225 begins, as in the oracle; that can be inside the IRQ or a DMA.
- **Overrides** (`Runner.override(pc, fn)`): a TypeScript function registered at an address
  runs instead of the translated code. The address may be inside a routine: translated blocks
  end before every override, so execution always reaches it. New modes work this way, in
  `packages/rules/src/overrides.ts` (`installRules`), reading the `Ruleset`; classic installs
  none. `npx tsx tools/disasm.ts <address> [count]` disassembles the ROM to write them.
  `Runner.split` ends blocks at an address without replacing code and `Runner.original` runs
  the original code up to the next block end, so an override can wrap one original instruction.
- **Determinism**: integers only; no clocks, randomness or platform APIs in `packages/core`
  (`npm run lint:core`). Online play depends on it.

## Modes

`packages/rules`: a `Ruleset` per mode, `installRules(game, rules)` before the game runs. Every
peer of a room installs the same one.

**2 vs 2 in the full arena** (`team-arena`, `Ruleset.singlesArena`). A team match (four
wrestlers, the original team logic: partners, targets, HUD, judge) played in the singles
environment: the wide arena with the floor around the ring, the front crowd and the apron,
going out and back in, the ringside items. The game picks its environment by `$1BA0` bit 6
(team), read at about a hundred sites; all were read (`tools/disasm.ts`, `../ssm-disasm`
notes) and sorted into team logic (kept) and environment (`ARENA_SITES` in
`rules/src/overrides.ts`, each with the reason). An environment site runs the original
instruction with the team bit hidden, so the singles path follows; singles matches are
unchanged (checked to the clock against the emulator). Besides the sites:

- Camera (`rules/src/camera.ts`, at C11F71): the team camera frames the four wrestlers but
  stays in the narrow team arena (x 60..120, y up to 68). It keeps the team framing with the
  singles arena's limits (x 20..160, y 0..C0) and, with someone on the floor, the singles floor
  rule for y. Not the singles snap to an arena side: with four wrestlers it would drop the
  others from the picture; the team pull into the screen (C18E49) keeps everyone visible.
- Items (`rules/src/items.ts`): the team frame order lacks the singles item steps, the throw-in
  of new items (C11007) and their tick and drawing (C2032D). They run after the team parent
  through a return address in a ROM gap (C07F00), so the call chain lives on the game's stack.
- Arena objects (`rules/src/arena.ts`, at C02631): the match start creates the arena's objects
  from one of two tables; this mode creates the team set plus what only singles have (the
  ropes' scroll object 38, the side ropes 22 and their pieces 24), without the team arena's
  rope shake 7C, which poses tiles into the BG maps where the singles maps have the posts.
- Speed: four wrestlers in the singles arena overrun the SNES frame (the game ran at about 60%
  outside the ring). Team matches in this mode set `Machine.overclock` = 1 at the match start:
  CPU and DMA spend half the clocks, the video timing stays.
- Sprite memory (`rules/src/sprites.ts`): sprite VRAM cannot hold both environments (the four
  team wrestlers stream into D000-FFFF, where singles keep the side-rope tiles and the item
  frames). The singles sprite tiles go to a second sprite bank, a Machine extension the
  original never uses: VMAIN bit 6 sends VRAM writes there, and OAM entries flagged in
  `oamxNext` (committed by the next OAM DMA) draw from it, with the bank's own sprite palettes
  (`cgramx`: the game's, but palette 7 keeps the items' colors, which team play gives to the
  fourth wrestler). The objects that draw singles graphics use it: items, side ropes 22 / 24,
  combat effects 3C (their floor-impact frames would otherwise show team play's letters). The
  flags stay while the arena objects exist (a paused game re-uploads the same OAM) and are
  cleared at C00369 once the pool no longer has them, so menus never inherit them.
- Standing with an item (C1A569 / C1A594): team play fixes the standing pose; with an item in
  hand the singles pose selection runs, which picks the pose holding it.
- Count-out (`rules/src/countout.ts`): team play has no referee, so the count runs without one,
  with the singles rule: each clock second while someone stands outside (+152) the count
  `$1A60` goes up and shows (the singles digits banner); everyone back in resets it; at 20 the
  team with someone outside loses (COUNT OUT), both teams outside both lose (DOUBLE COUNT OUT),
  ending the round through the team referee's own path (members left = 0).
- Wide picture (`rules/src/wide.ts`, `Ruleset.screenWidth` = 400, 16:9; 4x is 1600 x 896): the
  arena (576 px) is already whole in the BG1 / BG2 maps, so the renderer only draws more of
  them; `Machine.wide` (the margin, 72) is set at the match start and cleared with the arena,
  so menus and singles stay 256 px between black sides. BG3 (the HUD) stays in the middle;
  sprite pieces beyond the 256 carry their real x (`Machine.oamWideX`). The game is told its
  screen is wider where it decides by it: the culls (x + a < b, seven sites), the screen pull
  C18E49, the off-screen arrows, and the camera clamps and margins.
- Not in team play, so not in this mode: the referee himself (singles uses object 0C00, a
  wrestler in team play).

`rules/test/team-arena.test.ts` drives player 1 with a bot (`test/bot.ts`: goals checked
against WRAM) through a Team Battle Royal reached from power-on: classic keeps the ropes shut,
the full arena lets him out and back in with the camera on the floor, the items run, and a
rollback in such a match restores the same state.

## Timing

The model is the oracle's (snes9x), in `cpu/timing.ts`. The Machine counts master clocks
within the scanline (`cyc`) and the line (`vline`, 262 per frame). Every bus access costs the
clocks of its memory region (6 / 8 / 12, FastROM after `$420D`), and the translator adds each
instruction's fetches and internal cycles, so the code knows the beam position. The fixed
events of a line run as time passes them: DRAM refresh (40 clocks), HDMA (with its own table
walk and cost), the line end. General DMA costs 8 clocks a byte. The H/V timer IRQ fires at
its position in clocks, and blocks return at the next instruction boundary once it is due, so
the controller IRQ (line 31) lands inside the main loop where it would on hardware. WAI,
CLI / SEI latency and `$4210-$4212` follow the same model.

The sound unit runs behind the CPU and catches up whenever the CPU touches its ports and at
every line end, as in snes9x: master clocks convert to SPC clocks at 15664 / 328125, with the
remainder carried over.

Seeded from an emulator frame boundary (`tools/oracle/dump.py` records the CPU state and the
sound unit's), a match and the attract mode reach every later boundary on the same
instruction, line and clock as the trace core, with identical WRAM
(`packages/core/test/timing.test.ts`). From power-on the same holds for the boot, which
waits on the sound CPU while the game uploads the driver and its samples
(`game.test.ts`).

## Online

Rollback netcode (GGPO-style). Only pad words travel, and every peer runs the whole game.
Local input is delayed by 1-2 frames on a LAN, 2-3 over the internet. A missing remote input
is predicted, and when the real one differs, the peer restores the snapshot of that frame
and re-simulates (at most 8 frames, then it stalls). Packets repeat the unacknowledged
inputs, so they work over WebSocket now and over WebRTC data channels later. A periodic
checksum detects desyncs. The session is `Rollback` (`net/rollback.ts`, in the core, so it is
deterministic and tested without a network): `addInput(slot, frame, pad)` in frame order,
`advance()` once per frame, snapshots in preallocated buffers (a frame costs about 2 ms, a
snapshot 0.1 ms). `rollback.test.ts` runs two peers through a simulated network with latency,
jitter and stalls, and checks they end in the state of a run without network.

`Netplay` (`net/netplay.ts`) adds the exchange, over any in-order transport: the local pad of
tick t is the input of frame t + delay; each input packet repeats the unacknowledged inputs
and carries what the sender has of every slot (the acks) and how many frames it is ahead of
each peer (time sync: the peer that runs ahead skips a tick now and then); checksums every
60 frames are compared across peers. `netplay.test.ts` runs 2 and 3 peers that start at
different times through a simulated relay.

In the browser (`apps/web`), a room is a name on the server: the peer that joined first is
the host, picks the input delay and starts; its `start` message fixes the slots (join order)
for everyone. Transport: the server's WebSocket relay (LAN / VPN now, a cloud
server later).

## Picture and sound

- **Picture** (`ppu/render.ts`): each line is drawn when the beam reaches it (line event at
  clock 512), from VRAM, CGRAM, OAM and the PPU registers at that moment, so HDMA and
  mid-frame writes land where they do on hardware. It draws what the game uses: BG mode 1,
  sprites with the per-line limits, windows, color math with the fixed color, brightness.
  Pixels are RGB565 with the oracle's arithmetic, and match the emulator's frames exactly
  (`timing.test.ts`, dumps made with `--video`; `tools/compare-video.ts` writes PNGs of a
  difference). The renderer is outside the rollback state: detach it while re-simulating.
- **Sound** (`apu/`): the SPC700 (`smp.ts`) and the DSP (`dsp.ts`), ported from the
  oracle's snes9x core (bsnes's SMP, blargg's SPC_DSP), with integer maths only. The game
  uploads its own driver and samples, then sends it commands, as on hardware. The DSP's
  output (32040 Hz stereo) matches the emulator's sample for sample (`sound.test.ts`, dumps
  made with `--audio`). `Sound` hands each frame's samples to the host, and like the renderer
  it should be detached while a rollback re-simulates. The browser plays them through an
  AudioWorklet (`apps/web/src/audio.ts`), which reads a little faster or slower to follow
  the display's pace.

## Client screens

Menus (`apps/web`) are designed on a fixed 1600x900 screen that `Fit` (`Fit.tsx`) scales to
the window with CSS zoom, so they fit without scrolling on 16:9 and 16:10; text is 24 px,
never under 16 px, at that size. The game is alone on a black screen at the largest integer
scale that fits (4x at 1920x1080, 5x at 1920x1200), and Esc leaves. Keyboard: W A S D move,
K attacks (Y), Space jumps (B), E pins (A), Enter is START; gamepads map by position.

## Tests

`npm run check` runs the typecheck, the core purity check and the tests. Tests that need the
ROM or emulator dumps skip without them. Make the dumps with the tools in `tools/oracle`,
which use the emulator harness in `../ssm-disasm`:

```sh
python3 tools/oracle/dump.py --core trace --input match1 --start 0 --frames 1200 --full --out fixtures/boot-trace
python3 tools/oracle/dump.py --core trace --input match1 --start 2830 --frames 600 --full --video --audio --out fixtures/match1-2830-trace
tools/oracle/capture.sh rom_c1_motion match1 F40-1 F12-4 F53-2
```
