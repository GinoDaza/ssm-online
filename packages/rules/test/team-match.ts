/**
 * A Team Battle Royal reached from power-on (ssm-disasm inputs/T013-team.txt, pad 1 is Jumbo),
 * for the tests of team matches in the singles arena: snapshots at the end of the team
 * selection, then the match with a ruleset installed.
 */
import { beforeAll, expect } from 'vitest';
import { Game, padsFromScript } from '@ssm/core';
import { installRules, type Ruleset } from '../src/index.ts';
import { loadRom } from '../../core/test/fixture.ts';

/** ssm-disasm inputs/T013-team.txt: power-on, Team Battle Royal (pad 1 is Jumbo), the match. */
export const SCRIPT =
  'wait*650 start*4 wait*60 start*4 wait*220 right*4 wait*30 y*4 wait*150 y*4 wait*60 right*4 y*4 wait*60 right*4 y*4 wait*60 y*4 wait*60 y*4 wait*1800 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40';
/** the team selection is done and nothing the rules touch has run yet */
export const SELECTED = 1400;
/** the match is on */
export const FIGHT = 3900;

export function steps(offset: number): string[] {
  const out = Array<string>(offset).fill('wait');
  for (const t of SCRIPT.split(' ')) {
    const [s, n] = t.split('*');
    for (let k = 0; k < Number(n); k++) out.push(s!);
  }
  return out;
}

export const w16 = (g: Game, a: number) => g.m.wram[a]! | (g.m.wram[a + 1]! << 8);

/** Call in a describe: boots to the selection once per power-on offset; returns fight(). */
export function teamMatch(offsets: number[] = [0]): (rules: Ruleset, offset?: number) => Game {
  /** snapshots at SELECTED, by power-on offset (the offset changes the RNG: 2 brings items) */
  const selected = new Map<number, Uint8Array>();
  beforeAll(() => {
    for (const offset of offsets) {
      const g = new Game(loadRom());
      g.powerOn();
      const st = steps(offset);
      for (let f = 0; f < SELECTED; f++) g.step(padsFromScript(st[f] ?? 'wait').slice(0, 4));
      selected.set(offset, g.m.save());
    }
  }, 60_000);

  /** A game with `rules` at the start of the fight. */
  function fight(rules: Ruleset, offset = 0): Game {
    const g = new Game(loadRom());
    installRules(g, rules);
    g.m.load(selected.get(offset)!);
    const st = steps(offset);
    for (let f = SELECTED; f < FIGHT; f++) g.step(padsFromScript(st[f] ?? 'wait').slice(0, 4));
    expect(g.m.wram[0x1ba0]! & 0x40, 'a team match').toBe(0x40);
    return g;
  }
  return fight;
}
