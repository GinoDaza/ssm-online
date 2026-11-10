/**
 * Team matches in the singles arena (teamArenaRules), against the original (classicRules):
 * singles stay the original, a team match gets the floor around the ring (out and back in,
 * the camera following), the ringside items run, and rollback still restores everything.
 */
import { describe, expect, it } from 'vitest';
import { Game, PAD, padsFromScript } from '@ssm/core';
import { classicRules, installRules, teamArenaRules } from '../src/index.ts';
import { hasFixture, haveRom, loadFixture, loadRom } from '../../core/test/fixture.ts';
import { Bot } from './bot.ts';
import { teamMatch, w16 } from './team-match.ts';

describe.skipIf(!haveRom())('team matches in the singles arena: play', () => {
  const fight = teamMatch([0]);

  it.skipIf(!hasFixture('match1-2830-trace'))('a singles match is still the original, to the clock (but the picture)', () => {
    const fx = loadFixture('match1-2830-trace');
    const g = new Game(loadRom());
    installRules(g, { ...teamArenaRules, wideSingles: false });
    g.seed(fx.record(0), fx.cpu(0)!, fx.apu);
    const bad: string[] = [];
    for (let f = 0; f < fx.frames && bad.length < 3; f++) {
      g.step(padsFromScript(fx.pads[f] ?? 'wait'));
      const want = fx.record(f + 1);
      const c = fx.cpu(f + 1)!;
      let n = 0;
      for (let i = 0; i < want.length; i++) if (g.m.wram[i] !== want[i]) n++;
      if (n || g.m.cyc !== c.h || g.m.vline !== c.v) bad.push(`frame ${f + 1}: ${n} WRAM bytes, line ${g.m.vline} clock ${g.m.cyc}`);
    }
    expect(bad).toEqual([]);
  }, 60_000);

  const outAndBack = (g: Game) => {
    const bot = new Bot(g, [
      { kind: 'goto', x: 320, depth: 360 },
      { kind: 'exit', dir: PAD.DOWN },
      { kind: 'wait', frames: 300 },
      { kind: 'enter', dir: PAD.UP },
    ]);
    let lowest = 0;
    let count = 0;
    for (let f = 0; f < 2000 && !bot.done; f++) {
      g.step([bot.pad(), 0, 0, 0]);
      lowest = Math.max(lowest, w16(g, 0x1a8d));
      count = Math.max(count, g.m.wram[0x1a60]!);
    }
    return { results: bot.results, cameraY: lowest, count, countNow: g.m.wram[0x1a60]! };
  };

  it('classic: the ropes hold and the camera stays on the ring', () => {
    const r = outAndBack(fight(classicRules));
    expect(r.results[1], 'out').toBe(-1);
    expect(r.cameraY).toBeLessThanOrEqual(0x68);
  }, 60_000);

  it('full arena: out through the front ropes, the camera down to the floor, back in', () => {
    const r = outAndBack(fight(teamArenaRules));
    expect(r.results[1], 'out').toBeGreaterThan(0);
    expect(r.results[3], 'back in').toBeGreaterThan(0);
    expect(r.cameraY).toBeGreaterThan(0x90);
    // the count ran while he was outside (300 frames: about 5) and went back to 0
    expect(r.count).toBeGreaterThanOrEqual(3);
    expect(r.count).toBeLessThan(20);
    expect(r.countNow).toBe(0);
  }, 60_000);

  it('full arena: 20 seconds outside is a count out, his team loses', () => {
    const g = fight(teamArenaRules);
    const bot = new Bot(g, [
      { kind: 'goto', x: 320, depth: 360 },
      { kind: 'exit', dir: PAD.DOWN },
      { kind: 'wait', frames: 3000 },
    ]);
    let countOut = false;
    let state = 0;
    for (let f = 0; f < 3000 && state !== 0x22 && state !== 0x20; f++) {
      g.step([bot.pad(), 0, 0, 0]);
      countOut ||= g.m.wram[0x1a62] === 1;
      state = g.m.wram[0x56]!;
    }
    expect(countOut, 'COUNT OUT').toBe(true);
    expect(state.toString(16), 'his team lost (22), did not win (20)').toBe('22');
  }, 60_000);
});
