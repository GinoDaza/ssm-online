/**
 * Team matches in the singles arena (teamArenaRules), against the original (classicRules):
 * singles stay the original, a team match gets the floor around the ring (out and back in,
 * the camera following), the ringside items run, and rollback still restores everything.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Game, PAD, Rollback, checksum, padsFromScript } from '@ssm/core';
import { classicRules, installRules, teamArenaRules, type Ruleset } from '../src/index.ts';
import { hasFixture, haveRom, loadFixture, loadRom } from '../../core/test/fixture.ts';
import { Bot } from './bot.ts';

/** ssm-disasm inputs/T013-team.txt: power-on, Team Battle Royal (pad 1 is Jumbo), the match. */
const SCRIPT =
  'wait*650 start*4 wait*60 start*4 wait*220 right*4 wait*30 y*4 wait*150 y*4 wait*60 right*4 y*4 wait*60 right*4 y*4 wait*60 y*4 wait*60 y*4 wait*1800 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40 left*30 y*4 wait*40 a*4 wait*40 right*30 y*4 wait*40 b*4 wait*40';
/** the team selection is done and nothing the rules touch has run yet */
const SELECTED = 1400;
/** the match is on */
const FIGHT = 3900;

function steps(offset: number): string[] {
  const out = Array<string>(offset).fill('wait');
  for (const t of SCRIPT.split(' ')) {
    const [s, n] = t.split('*');
    for (let k = 0; k < Number(n); k++) out.push(s!);
  }
  return out;
}

const w16 = (g: Game, a: number) => g.m.wram[a]! | (g.m.wram[a + 1]! << 8);

describe.skipIf(!haveRom())('team matches in the singles arena', () => {
  /** snapshots at SELECTED, by power-on offset (the offset changes the RNG: 2 brings items) */
  const selected = new Map<number, Uint8Array>();
  beforeAll(() => {
    for (const offset of [0, 2]) {
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

  it.skipIf(!hasFixture('match1-2830-trace'))('a singles match is still the original, to the clock', () => {
    const fx = loadFixture('match1-2830-trace');
    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
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
    for (let f = 0; f < 2000 && !bot.done; f++) {
      g.step([bot.pad(), 0, 0, 0]);
      lowest = Math.max(lowest, w16(g, 0x1a8d));
    }
    return { results: bot.results, cameraY: lowest };
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
  }, 60_000);

  it('full arena: the ringside items are set up and run', () => {
    const items = (g: Game) => [0x1000, 0x1080].map((d) => g.m.wram[d]!);
    // C18BBF set them up in this match; C2032D initialises them (+00 bit 7) on its first frame
    expect(items(fight(teamArenaRules, 2)).map((v) => v & 0x80)).toEqual([0x80, 0x80]);
    expect(items(fight(classicRules, 2))).toEqual([0, 0]);
  }, 60_000);

  it('full arena: the side ropes are created and drawn from the second sprite bank', () => {
    const g = fight(teamArenaRules);
    const types = new Set<number>();
    for (let d = 0x1200; d < 0x1a00; d += 0x40) if (g.m.wram[d]) types.add(g.m.wram[d + 1]!);
    for (const t of [0x22, 0x24, 0x38, 0x4a]) expect(types.has(t), `pool type ${t.toString(16)}`).toBe(true);
    // the team arena's rope shake writes into the BG maps, where the singles maps have the posts
    expect(types.has(0x7c), 'no team rope shake').toBe(false);
    // the rope tiles (list 72's DC00 part) are in the bank, the team wrestlers keep VRAM D000-FFFF
    expect(g.m.objx.subarray(0x1c00, 0x2000).some((v) => v !== 0)).toBe(true);
    // and their palettes: the items' palette 7 (palette list 4: CB:FBC0), not the 4th wrestler's
    const items = Array.from({ length: 32 }, (_, i) => g.m.rom.u8(0xcbfbc0 + i));
    expect(Array.from(g.m.cgramx.subarray(0xe2, 0x100))).toEqual(items.slice(2));
    expect(Array.from(g.m.cgram.subarray(0x1e2, 0x200))).not.toEqual(items.slice(2));
    const classic = fight(classicRules);
    expect(classic.m.objx.every((v) => v === 0)).toBe(true);
    expect(classic.m.oamx.every((v) => v === 0)).toBe(true);
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
