/** The whole game: boots, is deterministic, and follows the emulator through boot. */
import { describe, expect, it } from 'vitest';
import { Game, checksum } from '../src/index.ts';
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

  // python3 tools/oracle/dump.py --input match1 --start 0 --frames 1200 --full --out fixtures/boot-full
  it.skipIf(!hasFixture('boot-full'))('boot WRAM matches the emulator within 4 bytes', () => {
    // the APU stand-in answers uploads at once, so the emulator runs a few frames behind
    const fx = loadFixture('boot-full');
    const g = new Game(loadRom());
    g.powerOn();
    for (let f = 1; f <= 100; f++) {
      g.step([0, 0, 0, 0]);
      if (f !== 60 && f !== 100) continue;
      let best = Infinity;
      for (let k = f - 6; k <= f + 6; k++) {
        const r = fx.record(k);
        let n = 0;
        for (let i = 0; i < r.length; i++) if (r[i] !== g.m.wram[i] && !(i >= 0x100 && i < 0x300)) n++;
        best = Math.min(best, n);
      }
      expect(best, `frame ${f}`).toBeLessThanOrEqual(4);
    }
  });
});
