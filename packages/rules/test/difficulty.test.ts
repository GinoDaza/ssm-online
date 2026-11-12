/**
 * The default difficulty (Ruleset.difficulty): a Single Match from power-on starts with the
 * ruleset's OPTION level and the CPU at its rank (C0:ABA1[level] >> 3); the original's 3 gives
 * the original level 9.
 */
import { describe, expect, it } from 'vitest';
import { Game, padsFromScript } from '@ssm/core';
import { classicRules, installRules, teamArenaRules, type Ruleset } from '../src/index.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

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

/** the OPTION level and the CPU's (+7A of the wrestler with +77 = 0) */
const levels = (g: Game) => {
  const cpu = [0x800, 0xa00].find((d) => g.m.wram[d + 0x77] === 0)!;
  return [g.m.wram[0x3b0], g.m.wram[cpu + 0x7a]];
};

describe.skipIf(!haveRom())('the default difficulty', () => {
  it('both modes start two levels up: OPTION 5, CPU level 15', () => {
    expect(classicRules.difficulty).toBe(5);
    expect(levels(singles(classicRules))).toEqual([5, 15]);
    expect(levels(singles(teamArenaRules))).toEqual([5, 15]);
  }, 120_000);

  it("the original's level 3 installs nothing: CPU level 9", () => {
    const g = singles({ ...classicRules, difficulty: 3 });
    expect(g.runner.overrides.has(0xc01320)).toBe(false);
    expect(levels(g)).toEqual([3, 9]);
  }, 120_000);
});
