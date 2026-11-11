/** Overrides: one registered inside a translated block is still reached through the dispatcher. */
import { describe, expect, it } from 'vitest';
import { Game, checksum } from '../src/index.ts';
import { haveRom, loadRom } from './fixture.ts';

describe.skipIf(!haveRom())('overrides', () => {
  it('an override inside a block runs, and one that runs the original changes nothing', () => {
    const run = (at: number | null): [number, number] => {
      const g = new Game(loadRom());
      let calls = 0;
      // 00FFA5 is the third instruction of the reset code (STZ $420C; LDA #$80; STA $2100)
      if (at !== null) {
        g.runner.override(at, (c) => {
          calls++;
          return g.runner.translator.get(c, at)(c);
        });
      }
      g.powerOn();
      for (let f = 0; f < 300; f++) g.step([0, 0, 0, 0]);
      return [checksum(g.m.save()), calls];
    };
    const [want] = run(null);
    const [got, calls] = run(0x00ffa5);
    expect(calls).toBe(1);
    expect(got).toBe(want);
  });

  it('an address takes one override: a second throws, null frees it', () => {
    const g = new Game(loadRom());
    const fn = () => 0;
    g.runner.override(0x00ffa5, fn);
    expect(() => g.runner.override(0x00ffa5, fn)).toThrow('FFA5 already registered');
    g.runner.override(0x00ffa5, null);
    expect(() => g.runner.override(0x00ffa5, fn)).not.toThrow();
  });
});
