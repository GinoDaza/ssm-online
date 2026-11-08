/** The whole game: boots, is deterministic, and follows the emulator from power-on. */
import { describe, expect, it } from 'vitest';
import { Game, checksum, padsFromScript } from '../src/index.ts';
import { hasFixture, haveRom, loadFixture, loadRom } from './fixture.ts';

describe.skipIf(!haveRom())('game', () => {
  it('runs 300 frames deterministically', () => {
    const run = () => {
      const g = new Game(loadRom());
      g.powerOn();
      for (let f = 0; f < 300; f++) g.step([0, 0, 0, 0]);
      return checksum(g.m.save());
    };
    expect(run()).toBe(run());
  });

  // python3 tools/oracle/dump.py --core trace --input match1 --start 0 --frames 1200 --full --out fixtures/boot-trace
  it.skipIf(!hasFixture('boot-trace'))('boots as the trace core does, to the clock (sound driver uploads included)', () => {
    const fx = loadFixture('boot-trace');
    const g = new Game(loadRom());
    g.powerOn();
    const bad: string[] = [];
    for (let f = 0; f < fx.frames && bad.length < 5; f++) {
      g.step(padsFromScript(fx.pads[f] ?? 'wait'));
      const want = fx.record(f + 1);
      const c = fx.cpu(f + 1)!;
      const m = g.m;
      let n = 0;
      for (let i = 0; i < want.length; i++) if (m.wram[i] !== want[i]) n++;
      const at = `pc ${m.pc.toString(16)} line ${m.vline} clock ${m.cyc}`;
      const wantAt = `pc ${((c.pb << 16) | c.pc).toString(16)} line ${c.v} clock ${c.h}`;
      if (n) bad.push(`frame ${f + 1}: ${n} WRAM bytes differ`);
      else if (at !== wantAt) bad.push(`frame ${f + 1}: ${at}, emulator ${wantAt}`);
    }
    expect(bad).toEqual([]);
  });
});
