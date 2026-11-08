/**
 * Cycle timing against the oracle: seeded from an emulator frame boundary (WRAM and CPU
 * state), the translated game must reach every later boundary on the same instruction, line
 * and master clock, with the same WRAM. Dumps (local, git-ignored):
 *   python3 tools/oracle/dump.py --core trace --input match1 --start 2830 --frames 600 --full --out fixtures/match1-2830-trace
 *   python3 tools/oracle/dump.py --core trace --input T013-attract-long --start 12000 --frames 300 --full --out fixtures/T013-attract-long-12000-trace
 *   python3 tools/oracle/dump.py --input match1 --start 2830 --frames 600 --full --out fixtures/match1-2830-full
 * The trace core (snes9x 1bcc369) is matched to the clock. The libretro buildbot core is a
 * newer snes9x whose timing differs by a few clocks (a long DMA can then end a frame a line
 * later), so against it only WRAM outside the stack page is compared. Scenes where the game waits on the sound CPU
 * (sample uploads between rounds) need the SPC700 and are not covered yet.
 */
import { describe, expect, it } from 'vitest';
import { Game, Renderer, checksum, padsFromScript } from '../src/index.ts';
import { hasFixture, hasPicture, haveRom, loadFixture, loadRom } from './fixture.ts';

function follow(name: string, exact: boolean): string[] {
  const fx = loadFixture(name);
  const g = new Game(loadRom());
  g.seed(fx.record(0), fx.cpu(0)!);
  const bad: string[] = [];
  for (let f = 0; f < fx.frames && bad.length < 5; f++) {
    g.step(padsFromScript(fx.pads[f] ?? 'wait'));
    const want = fx.record(f + 1);
    const c = fx.cpu(f + 1)!;
    const m = g.m;
    let n = 0;
    for (let i = 0; i < want.length; i++) if (m.wram[i] !== want[i] && (exact || i < 0x100 || i >= 0x300)) n++;
    const at = `pc ${m.pc.toString(16)} line ${m.vline} clock ${m.cyc}`;
    const want_at = `pc ${((c.pb << 16) | c.pc).toString(16)} line ${c.v} clock ${c.h}`;
    if (n) bad.push(`frame ${f + 1}: ${n} WRAM bytes differ`);
    else if (exact && at !== want_at) bad.push(`frame ${f + 1}: ${at}, emulator ${want_at}`);
  }
  return bad;
}

describe.skipIf(!haveRom())('cycle timing', () => {
  it.skipIf(!hasFixture('match1-2830-trace'))('a match follows the trace core to the clock', () => {
    expect(follow('match1-2830-trace', true)).toEqual([]);
  });

  it.skipIf(!hasFixture('T013-attract-long-12000-trace'))('the attract mode follows the trace core to the clock', () => {
    expect(follow('T013-attract-long-12000-trace', true)).toEqual([]);
  });

  it.skipIf(!hasFixture('match1-2830-full'))('a match follows the buildbot core in WRAM', () => {
    expect(follow('match1-2830-full', false)).toEqual([]);
  });

  // python3 tools/oracle/dump.py --core trace --video ... (as above, with --video)
  for (const name of ['match1-2830-trace', 'T013-attract-long-12000-trace']) {
    it.skipIf(!hasPicture(name))(`${name}: the picture is the emulator's, pixel for pixel`, () => {
      const fx = loadFixture(name);
      const g = new Game(loadRom());
      g.seed(fx.record(0), fx.cpu(0)!, fx.ppu);
      const r = new Renderer(g.m);
      r.attach();
      const bad: string[] = [];
      for (let f = 0; f < fx.frames && bad.length < 5; f++) {
        g.step(padsFromScript(fx.pads[f] ?? 'wait'));
        const want = fx.picture(f + 1)!;
        let n = 0;
        for (let i = 0; i < want.length; i++) if (r.pixels[i] !== want[i]) n++;
        if (n) bad.push(`frame ${f + 1}: ${n} pixels differ`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('a snapshot restores the timing state too (rollback)', () => {
    const g = new Game(loadRom());
    g.powerOn();
    const pads = (f: number) => [f % 50 < 2 ? 0x1000 : 0, 0, 0, 0]; // press START now and then
    for (let f = 0; f < 400; f++) g.step(pads(f));
    const snap = g.m.save();
    for (let f = 400; f < 500; f++) g.step(pads(f));
    const want = checksum(g.m.save());
    g.m.load(snap);
    for (let f = 400; f < 500; f++) g.step(pads(f));
    expect(checksum(g.m.save())).toBe(want);
  });
});
