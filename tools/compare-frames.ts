/**
 * Run the translated game from an oracle dump and compare its WRAM with the emulator's frame by
 * frame (diagnostic, prints the differing bytes; the stack page $0100-$02FF is not compared):
 *   python3 tools/oracle/dump.py --input match1 --start 2830 --frames 600 --full --out fixtures/match1-2830-full
 *   npx tsx tools/compare-frames.ts match1-2830-full 600      (SHIFT=-1 delays the input a frame)
 * The dump must record the CPU state (`cpu` in its JSON): the game is seeded from record 0.
 */
import { Game, padsFromScript } from '@ssm/core';
import { loadFixture, loadRom } from '../packages/core/test/fixture.ts';

const name = process.argv[2] ?? 'match1-2830-full';
const fx = loadFixture(name);
const cpu = fx.cpu(0);
if (!cpu) throw new Error(`${name}: no CPU state, make the dump again with tools/oracle/dump.py`);
const g = new Game(loadRom());
g.seed(fx.record(0), cpu);
const N = Math.min(fx.frames, Number(process.argv[3] ?? 600));
const shift = Number(process.env.SHIFT ?? 0);
const hex = (v: number) => v.toString(16);
let firstBad = -1;
let badFrames = 0;
for (let f = 0; f < N; f++) {
  g.step(padsFromScript(fx.pads[f + shift] ?? 'wait'));
  const want = fx.record(f + 1);
  const bad: number[] = [];
  for (let i = 0; i < want.length; i++) if (g.m.wram[i] !== want[i] && !(i >= 0x100 && i < 0x300)) bad.push(i);
  const c = fx.cpu(f + 1);
  const where = c ? ` pc ${hex(g.m.pc)}/${hex((c.pb << 16) | c.pc)} line ${g.m.vline}/${c.v}` : '';
  if (bad.length) badFrames++;
  if (bad.length && firstBad < 0) firstBad = f;
  if (f < 3 || (bad.length && f < firstBad + 3) || f % 100 === 99)
    console.log(`frame ${f + 1}: ${bad.length} bytes differ${where}`, bad.slice(0, 12).map((i) => `${hex(i)}:${hex(g.m.wram[i]!)}/${hex(want[i]!)}`).join(' '));
}
console.log(firstBad < 0 ? `all ${N} frames match` : `first differing frame ${firstBad + 1}, ${badFrames} of ${N} differ`);
