/**
 * Run the translated game from an oracle WRAM dump and compare it with the emulator frame by
 * frame (diagnostic, prints the differing bytes):
 *   python3 tools/oracle/dump.py --input match1 --start 2830 --frames 600 --full --out fixtures/match1-2830-full
 *   npx tsx tools/compare-frames.ts match1-2830-full 600      (SHIFT=-1 delays the input a frame)
 * Known gaps: no cycle timing, so the controller IRQ (line 31) runs after the main loop instead
 * of inside it, and the emulator's frame boundary falls inside the line-215 IRQ
 * (docs/architecture.md, "Timing").
 */
import { readFileSync } from 'node:fs';
import { Game, RomImage, padsFromScript } from '@ssm/core';
const rom = new RomImage(new Uint8Array(readFileSync('roms/Saturday Night Slam Masters (USA).sfc')));
const name = process.argv[2] ?? 'match1-2830-full';
const meta = JSON.parse(readFileSync(`fixtures/${name}.json`, 'utf8'));
const data = new Uint8Array(readFileSync(`fixtures/${name}.wram`));
const R = meta.record;
const rec = (k: number) => data.subarray(k * R, (k + 1) * R);
const g = new Game(rom);
g.seed(rec(0));
const N = Math.min(meta.frames, Number(process.argv[3] ?? 600));
let firstBad = -1;
for (let f = 0; f < N; f++) {
  g.step(padsFromScript(f + Number(process.env.SHIFT ?? 0) >= 0 ? meta.pads[f + Number(process.env.SHIFT ?? 0)] ?? "wait" : "wait"));
  const want = rec(f + 1);
  const bad: number[] = [];
  for (let i = 0; i < R; i++) if (g.m.wram[i] !== want[i] && !(i >= 0x100 && i < 0x300)) bad.push(i);
  if (bad.length && firstBad < 0) firstBad = f;
  if (f < 3 || bad.length && f < firstBad + 3 || f % 100 === 99)
    console.log(`frame ${f + 1}: ${bad.length} bytes differ`, bad.slice(0, 12).map((i) => `${i.toString(16)}:${g.m.wram[i]!.toString(16)}/${want[i]!.toString(16)}`).join(' '));
}
console.log('first differing frame', firstBad + 1);
