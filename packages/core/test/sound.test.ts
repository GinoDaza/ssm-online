/**
 * The sound unit against the oracle: the DSP's output, seeded from an emulator frame boundary
 * (its savestate's SND block), must be the emulator's, sample for sample. The emulator's
 * stream comes through snes9x's resampler at ratio 1, which only delays it a few samples.
 *   python3 tools/oracle/dump.py --core trace --input match1 --start 2830 --frames 600 --full --video --audio --out fixtures/match1-2830-trace
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Game, Sound, padsFromScript } from '../src/index.ts';
import { ROOT, hasFixture, haveRom, loadFixture, loadRom } from './fixture.ts';

function hasAudio(name: string): boolean {
  return hasFixture(name) && existsSync(resolve(ROOT, 'fixtures', name + '.audio'));
}

describe.skipIf(!haveRom())('sound', () => {
  const name = 'match1-2830-trace';
  it.skipIf(!hasAudio(name))('a match sounds as in the emulator, sample for sample', () => {
    const fx = loadFixture(name);
    const b = readFileSync(resolve(ROOT, 'fixtures', name + '.audio'));
    const want = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
    const g = new Game(loadRom());
    g.seed(fx.record(0), fx.cpu(0)!, fx.apu);
    const sound = new Sound(g.m);
    sound.attach();
    const got = new Int16Array(want.length + 0x10000);
    let n = 0;
    for (let f = 0; f < fx.frames; f++) {
      g.step(padsFromScript(fx.pads[f] ?? 'wait'));
      const s = sound.take();
      got.set(s, n);
      n += s.length;
    }
    expect(n).toBe(want.length);
    // the delay (in values: 2 per sample pair) with the fewest differences
    let best = { delay: 0, bad: Infinity };
    for (let delay = 0; delay <= 256; delay += 2) {
      let bad = 0;
      for (let i = delay; i < want.length && bad < best.bad; i++) if (want[i] !== got[i - delay]) bad++;
      if (bad < best.bad) best = { delay, bad };
    }
    expect(best.bad).toBe(0);
    expect(want.subarray(best.delay).some((v) => v !== 0)).toBe(true);
  });
});
