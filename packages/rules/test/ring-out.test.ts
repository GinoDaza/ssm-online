/**
 * Ring-out in team play: from a Team Battle Royal (player 1 is Jumbo, CPU partner and
 * opponents), a double tap down at the front ropes leaves the ring only with the ring-out
 * rules, and a double tap toward the ring climbs back in.
 */
import { describe, expect, it } from 'vitest';
import { Game, PAD, padsFromScript } from '@ssm/core';
import { classicTeamRules, installRules, teamRingOutRules, type Ruleset } from '../src/index.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

/** ssm-disasm inputs/T013-team.txt, from power-on into the match (Team Battle Royal). */
const TO_MATCH = 'wait*650 start*4 wait*60 start*4 wait*220 right*4 wait*30 y*4 wait*150 y*4 wait*60 right*4 y*4 wait*60 right*4 y*4 wait*60 y*4 wait*60 y*4 wait*1800 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40';
const MATCH_FRAME = 4000;

/** Hold `dir`, release, tap, release, hold again: the double tap, retried every 100 frames. */
const doubleTap = (f: number, dir: number) => {
  const t = f % 100;
  return t < 60 ? dir : t < 64 ? 0 : t < 68 ? dir : t < 72 ? 0 : dir;
};

describe.skipIf(!haveRom())('ring-out in team play', () => {
  const play = (rules: Ruleset) => {
    const g = new Game(loadRom());
    installRules(g, rules);
    g.powerOn();
    const steps = TO_MATCH.split(' ').flatMap((t) => {
      const [s, n] = t.split('*');
      return Array<string>(Number(n)).fill(s!);
    });
    for (let f = 0; f < MATCH_FRAME; f++) g.step(padsFromScript(steps[f] ?? 'wait').slice(0, 4));
    const onRing = () => g.m.wram[0x871] !== 0; // player 1 (Jumbo, object 0800): +71 = 0 on the floor
    expect(g.m.wram[0x1ba0]! & 0x40, 'team match').toBe(0x40);
    expect(onRing()).toBe(true);
    let leftAt = -1;
    for (let f = 0; f < 200; f++) {
      g.step([doubleTap(f, PAD.DOWN), 0, 0, 0]);
      if (leftAt < 0 && !onRing()) leftAt = f;
    }
    // walk along the floor, then a double tap toward the ring (it is to the left by then)
    for (let f = 0; f < 500; f++) g.step([f < 100 ? PAD.LEFT : 0, 0, 0, 0]);
    const outside = !onRing();
    let backAt = -1;
    for (let f = 0; f < 200 && leftAt >= 0; f++) {
      const t = f % 50;
      g.step([t < 20 ? PAD.LEFT : t < 24 ? 0 : t < 28 ? PAD.LEFT : t < 32 ? 0 : PAD.LEFT, 0, 0, 0]);
      if (backAt < 0 && onRing()) backAt = f;
    }
    return { leftAt, outside, backAt, overrides: g.runner.overrides.size };
  };

  it('classic team rules keep the original: no overrides, the ropes hold', () => {
    const r = play(classicTeamRules);
    expect(r.overrides).toBe(0);
    expect(r.leftAt).toBe(-1);
  }, 60_000);

  it('ring-out rules: out through the ropes, around the floor, and back in', () => {
    const r = play(teamRingOutRules);
    expect(r.leftAt).toBeGreaterThan(0);
    expect(r.outside).toBe(true);
    expect(r.backAt).toBeGreaterThan(0);
  }, 60_000);
});
