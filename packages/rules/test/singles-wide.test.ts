/**
 * Singles in the full-arena mode (Ruleset.wideSingles): a Single Match from power-on gets the
 * wide, full-height picture of 2 vs 2 and its camera (both wrestlers framed), the classic one
 * keeps the SNES picture.
 */
import { describe, expect, it } from 'vitest';
import { Game, PAD, padsFromScript } from '@ssm/core';
import { classicRules, installRules, teamArenaRules, type Ruleset } from '../src/index.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';
import { w16 } from './team-match.ts';

/** ssm-disasm inputs/match1.txt up to the match: Single Match, pad 1 is Biff. */
const SCRIPT = 'wait*654 start*4 wait*60 start*4 wait*220 y*4 wait*120 y*4';
const FIGHT = 2900;

function singles(rules: Ruleset): Game {
  const g = new Game(loadRom());
  installRules(g, rules);
  g.powerOn();
  const st = SCRIPT.split(' ').flatMap((t) => {
    const [s, n] = t.split('*');
    return Array<string>(Number(n)).fill(s!);
  });
  for (let f = 0; f < FIGHT; f++) g.step(padsFromScript(st[f] ?? 'wait').slice(0, 4));
  expect(g.m.wram[0x1ba0]! & 0x40, 'a singles match').toBe(0);
  return g;
}

describe.skipIf(!haveRom())('singles in the full arena: the wide picture', () => {
  it('full arena: wide and tall, the camera keeps both wrestlers on screen', () => {
    const g = singles(teamArenaRules);
    expect(g.m.wide).toBe(72);
    expect(g.m.tall).toBe(215);
    let worst = 0;
    for (let f = 0; f < 900; f++) {
      g.step([f < 450 ? PAD.LEFT : PAD.DOWN | (f & 16 ? PAD.B : 0), 0, 0, 0]);
      const cam = w16(g, 0x1a84);
      for (const d of [0x800, 0xa00]) {
        const x = w16(g, d + 0x13) - cam; // screen x on the SNES screen; the wide one is -72..328
        worst = Math.max(worst, -72 - x, x - 328);
      }
      expect(cam).toBeGreaterThanOrEqual(0x20 + 72);
      expect(cam).toBeLessThanOrEqual(0x160 - 72);
      expect(w16(g, 0x1a87)).toBeGreaterThanOrEqual(31);
    }
    expect(worst).toBeLessThanOrEqual(0);
  }, 120_000);

  it('full arena: each side rope shows its own shake frame', () => {
    const g = singles(teamArenaRules);
    const m = g.m;
    const rope = (arg: number) => {
      for (let d = 0x1200; d < 0x1a00; d += 0x40) if (m.wram[d + 1] === 0x22 && m.wram[d + 2] === arg) return d;
      throw new Error('no side rope');
    };
    // which object drew each OAM entry
    const owner = new Int32Array(128).fill(-1);
    for (const pc of [0xc1f6c7, 0xc1f74c, 0xc1f7bb]) {
      const prev = g.runner.overrides.get(pc)!;
      g.runner.override(pc, (c) => {
        owner.fill(c.x, c.wram[0xf4]! & 0x7f);
        return prev(c);
      });
    }
    const left = rope(0);
    let checked = 0;
    for (let f = 0; f < 450 && checked < 20; f++) {
      g.step([PAD.LEFT, 0, 0, 0]);
      const frame = m.wram[left + 0x1f]!;
      // the left rope shakes and the right one uploaded another frame to the shared place
      if (m.wram[0x1a79] === frame) continue;
      // its frame's graphics queue record (C00A8C): C5:word[C5:word[C0:D530] + 2 * frame]
      const u16 = (a: number) => m.rom.u8(a) | (m.rom.u8(a + 1) << 8);
      const rec = 0xc50000 | u16(0xc50000 | (u16(0xc0d530) + 2 * frame));
      const src = u16(rec + 3);
      expect(m.rom.u8(rec + 5), 'from WRAM').toBe(0x7e);
      expect((u16(rec + 6) << 1) & 0xffff, 'to DC00').toBe(0xdc00);
      const tiles = m.wram.subarray(src, src + u16(rec + 1));
      expect(Array.from(m.objx.subarray(0x3c00, 0x3f80))).toEqual(Array.from(tiles));
      let entries = 0;
      for (let e = 0; e < 128; e++) {
        if (owner[e] !== left) continue;
        expect(m.oamxNext[e]! & 9, `entry ${e}: bank 1, other half`).toBe(9);
        entries++;
      }
      expect(entries).toBeGreaterThan(0);
      checked++;
    }
    expect(checked, 'frames with the left rope shaking alone').toBeGreaterThan(0);
  }, 120_000);

  it('classic: the SNES picture', () => {
    const g = singles(classicRules);
    expect(g.m.wide).toBe(0);
    expect(g.m.tall).toBe(0);
  }, 120_000);
});
