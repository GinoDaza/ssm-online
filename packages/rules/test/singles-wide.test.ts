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

  it('classic: the SNES picture', () => {
    const g = singles(classicRules);
    expect(g.m.wide).toBe(0);
    expect(g.m.tall).toBe(0);
  }, 120_000);
});
