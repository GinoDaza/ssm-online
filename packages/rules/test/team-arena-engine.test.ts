/**
 * Team matches in the singles arena: the ringside items run, the CPU keeps up, and rollback
 * restores everything.
 */
import { describe, expect, it } from 'vitest';
import { Game, PAD, Rollback, checksum } from '@ssm/core';
import { classicRules, installRules, teamArenaRules } from '../src/index.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';
import { teamMatch } from './team-match.ts';

describe.skipIf(!haveRom())('team matches in the singles arena: items, speed, rollback', () => {
  const fight = teamMatch([0, 2]);

  it('full arena: the ringside items are set up and run', () => {
    const items = (g: Game) => [0x1000, 0x1080].map((d) => g.m.wram[d]!);
    // C18BBF set them up in this match; C2032D initialises them (+00 bit 7) on its first frame
    expect(items(fight(teamArenaRules, 2)).map((v) => v & 0x80)).toEqual([0x80, 0x80]);
    expect(items(fight(classicRules, 2))).toEqual([0, 0]);
  }, 60_000);

  it('full arena: twice the CPU, so four wrestlers do not slow the game down', () => {
    const count = (g: Game) => {
      let frames = 0;
      g.runner.split(0xc00f82);
      g.runner.override(0xc00f81, (c) => {
        frames++;
        return g.runner.original(c, 0xc00f81);
      });
      for (let f = 0; f < 300; f++) g.step([PAD.RIGHT, 0, 0, 0]);
      return frames;
    };
    const arena = fight(teamArenaRules);
    expect(arena.m.overclock).toBe(1);
    expect(count(arena)).toBeGreaterThanOrEqual(298);
    expect(fight(classicRules).m.overclock).toBe(0);
  }, 60_000);

  it('full arena: a rollback restores the camera, the items and the floor', () => {
    const start = fight(teamArenaRules, 2).m.save();
    const pad = (slot: number, f: number) => {
      let h = Math.imul((f >> 3) + 1, 0x9e3779b1) ^ Math.imul(slot + 5, 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
      return (h ^ (h >>> 12)) & 0xfff0;
    };
    const frames = 300;
    const straight = new Game(loadRom());
    installRules(straight, teamArenaRules);
    straight.m.load(start);
    for (let f = 0; f < frames; f++) straight.step([pad(0, f), pad(1, f), 0, 0]);

    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
    g.m.load(start);
    const session = new Rollback(g, { players: 2 });
    for (let f = 0; f < frames; f++) {
      session.addInput(0, f, pad(0, f));
      if (f >= 4) session.addInput(1, f - 4, pad(1, f - 4)); // pad 2 arrives four frames late
      session.advance();
    }
    for (let f = frames - 4; f < frames; f++) session.addInput(1, f, pad(1, f));
    session.sync();
    expect(session.rollbacks).toBeGreaterThan(0);
    expect(checksum(g.m.save())).toBe(checksum(straight.m.save()));
  }, 60_000);
});
