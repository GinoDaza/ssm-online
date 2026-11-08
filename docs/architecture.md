# Architecture

## Layout

```
apps/server      reads and checks the ROM, serves it and the client, WebSocket rooms (/ws)
apps/web         React client: loads the ROM, runs the game
packages/core    the game: 65816 -> JS translator, Machine, Game
packages/rules   game modes (Ruleset): classic, team ring-out, 4vs4
tools/oracle     emulator dumps and captured routine calls, for tests (needs ../ssm-disasm)
tools/           compare-frames.ts (game vs emulator), check-core-purity.mjs
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
- **Game** (`cpu/game.ts`): `powerOn()`, then `step(pads)` once per video frame. A frame is
  the video IRQ (C0023A) plus the main loop, from the scheduler's WAI (C000F8) to the next.
- **Overrides** (`Runner.overrides`): a TypeScript function registered at a routine's address
  runs instead of the translated code. New modes work this way: the routines that fix the
  player count or the ring size are rewritten to read the `Ruleset`.
- **Determinism**: integers only; no clocks, randomness or platform APIs in `packages/core`
  (`npm run lint:core`). Online play depends on it.

## Timing

The translator does not count cycles yet. In a match the main loop runs from scanline ~235
to ~124 of the next frame, and the controller IRQ (scanline 31) fires *inside* it. Here the
IRQs run between main-loop passes, so input is read at a slightly different point than on
hardware. Every peer runs the same code, so online play is consistent, but match frames
are not yet byte-identical to the emulator (`tools/compare-frames.ts`). The fix is
approximate cycle counting in the translator, with IRQs fired at their scanline. That also
models lag frames.

## Online

Rollback netcode (GGPO-style). Only pad words travel, and every peer runs the whole game.
Local input is delayed by 1-2 frames on a LAN, 2-3 over the internet. A missing remote input
is predicted, and when the real one differs, the peer restores the snapshot of that frame
and re-simulates (at most 8 frames, then it stalls). Packets repeat the unacknowledged
inputs, so they work over WebSocket now and over WebRTC data channels later. A periodic
checksum detects desyncs. Transport: the server's WebSocket relay (LAN / VPN now, a cloud
server later).

## Picture and sound

- **Picture**: a renderer that reads the video sink (BG modes, OBJ, windows, HDMA), so the
  picture is what the game draws.
- **Sound**: an SPC700 + DSP emulation running the game's own sound driver, fed with the
  commands the game sends.

## Tests

`npm run check` runs the typecheck, the core purity check and the tests. Tests that need the
ROM or emulator dumps skip without them. Make the dumps with the tools in `tools/oracle`,
which use the emulator harness in `../ssm-disasm`:

```sh
python3 tools/oracle/dump.py --input match1 --start 0 --frames 1200 --full --out fixtures/boot-full
tools/oracle/capture.sh rom_c1_motion match1 F40-1 F12-4 F53-2
```
