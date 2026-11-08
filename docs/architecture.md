# Architecture

## Layout

```
apps/server      reads and checks the ROM, serves it and the client, WebSocket rooms (/ws)
apps/web         React client: loads the ROM, runs the game
packages/core    the game: 65816 -> JS translator, Machine, Game, the picture (ppu/)
packages/rules   game modes (Ruleset): classic, team ring-out, 4vs4
tools/oracle     emulator dumps (WRAM + CPU state) and captured routine calls, for tests (needs ../ssm-disasm)
tools/           compare-frames.ts / compare-video.ts (game vs emulator), check-core-purity.mjs
```

## The game (packages/core)

- **Translator** (`cpu/compile.ts`). It translates a basic block of ROM code to a JavaScript
  function the first time the block runs, using the M / X register widths the CPU has at that
  moment, and caches it by (address, M, X). Every instruction is decoded with its real
  widths, so no static analysis is needed.
- **Machine** (`cpu/machine.ts`) holds the 65816 registers, 128 KiB of WRAM and the ROM. It
  also models the CPU I/O the game uses: multiply / divide, the WRAM port, DMA, and joypads
  (auto-read and serial). A video sink records VRAM, CGRAM and OAM writes. The APU is a
  stand-in that answers the SPC700 upload and command handshakes. All state that a rollback
  restores lives in one buffer: `save()` / `load()`, `checksum()`.
- **Game** (`cpu/game.ts`): `powerOn()`, then `step(pads)` once per video frame. Execution is
  one stream, as on hardware: the main loop, with the video IRQ (C0023A) taken at the
  instruction boundary where its H/V timer falls. A frame ends at the first instruction
  boundary after line 225 begins, as in the oracle; that can be inside the IRQ or a DMA.
- **Overrides** (`Runner.overrides`): a TypeScript function registered at a routine's address
  runs instead of the translated code. New modes work this way: the routines that fix the
  player count or the ring size are rewritten to read the `Ruleset`.
- **Determinism**: integers only; no clocks, randomness or platform APIs in `packages/core`
  (`npm run lint:core`). Online play depends on it.

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

Seeded from an emulator frame boundary (`tools/oracle/dump.py` records the CPU state), a
match and the attract mode reach every later boundary on the same instruction, line and
clock as the trace core, with identical WRAM (`packages/core/test/timing.test.ts`). The open
gap is the sound CPU: the APU stand-in answers uploads and commands at once, while the real
SPC700 takes time, so where the game waits on it (boot, sample uploads between rounds) it
runs ahead of the emulator. The SPC700 closes that.

## Online

Rollback netcode (GGPO-style). Only pad words travel, and every peer runs the whole game.
Local input is delayed by 1-2 frames on a LAN, 2-3 over the internet. A missing remote input
is predicted, and when the real one differs, the peer restores the snapshot of that frame
and re-simulates (at most 8 frames, then it stalls). Packets repeat the unacknowledged
inputs, so they work over WebSocket now and over WebRTC data channels later. A periodic
checksum detects desyncs. Transport: the server's WebSocket relay (LAN / VPN now, a cloud
server later).

## Picture and sound

- **Picture** (`ppu/render.ts`): each line is drawn when the beam reaches it (line event at
  clock 512), from VRAM, CGRAM, OAM and the PPU registers at that moment, so HDMA and
  mid-frame writes land where they do on hardware. It draws what the game uses: BG mode 1,
  sprites with the per-line limits, windows, color math with the fixed color, brightness.
  Pixels are RGB565 with the oracle's arithmetic, and match the emulator's frames exactly
  (`timing.test.ts`, dumps made with `--video`; `tools/compare-video.ts` writes PNGs of a
  difference). The renderer is outside the rollback state: detach it while re-simulating.
- **Sound**: an SPC700 + DSP emulation running the game's own sound driver, fed with the
  commands the game sends.

## Tests

`npm run check` runs the typecheck, the core purity check and the tests. Tests that need the
ROM or emulator dumps skip without them. Make the dumps with the tools in `tools/oracle`,
which use the emulator harness in `../ssm-disasm`:

```sh
python3 tools/oracle/dump.py --input match1 --start 0 --frames 1200 --full --out fixtures/boot-full
python3 tools/oracle/dump.py --core trace --input match1 --start 2830 --frames 600 --full --out fixtures/match1-2830-trace
tools/oracle/capture.sh rom_c1_motion match1 F40-1 F12-4 F53-2
```
