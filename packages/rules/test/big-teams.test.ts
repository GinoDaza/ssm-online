/**
 * 3 vs 3 and 4 vs 4 (teams.ts), from power-on: the Game Mode Select's 3 VS 3 / 4 VS 4, the
 * Team Battle Royal selection of ssm-disasm inputs/T013-team.txt (pad 1 is Jumbo; its
 * partner confirmations pick the team's extras first, select.ts), then the match: the extra
 * wrestlers are in, fight, are drawn (bank 2, the second OAM) with their HUD, the referee and
 * the judge count them, and a rollback restores everything.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Game, Renderer, Rollback, checksum, padsFromScript } from '@ssm/core';
import { installRules, teamArenaRules } from '../src/index.ts';
import { EXTRA, pages, teamSize } from '../src/slots.ts';
import { cursorCharacter, picks } from '../src/select.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

/** T013's team route with `size - 1` presses of right on the Game Mode Select */
function script(size: number): string[] {
  const rights = Array(size - 1).fill('right*4 wait*30').join(' ');
  const s = `wait*650 start*4 wait*60 start*4 wait*220 ${rights} y*4 wait*150 y*4 wait*60 right*4 y*4 wait*60 right*4 y*4 wait*60 y*4 wait*60 y*4 wait*1800`;
  const out: string[] = [];
  for (const t of s.split(' ')) {
    const [step, n] = t.split('*');
    for (let k = 0; k < Number(n); k++) out.push(step!);
  }
  return out;
}

/** the match is on (the walk-in is over) */
const FIGHT = 3900;

/** deterministic pseudo-random pads without START / SELECT */
const pad = (slot: number, f: number) => {
  let h = Math.imul((f >> 3) + 1, 0x9e3779b1) ^ Math.imul(slot + 5, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 12)) & 0xcff0;
};

describe.skipIf(!haveRom())('3 vs 3 and 4 vs 4', () => {
  const fights = new Map<number, Uint8Array>();
  beforeAll(async () => {
    for (const size of [3, 4]) {
      const g = new Game(loadRom());
      installRules(g, teamArenaRules);
      g.powerOn();
      const st = script(size);
      for (let f = 0; f < FIGHT; f++) {
        g.step(padsFromScript(st[f] ?? 'wait').slice(0, 4));
        if (f % 500 === 0) await new Promise((done) => setImmediate(done)); // let vitest's RPC through
      }
      fights.set(size, g.m.save());
    }
  }, 180_000);

  const fight = (size: number) => {
    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
    g.m.load(fights.get(size)!);
    return g;
  };

  for (const size of [3, 4]) {
    it(`${size} VS ${size}: ${2 * size} wrestlers fight, the extras drawn from bank 2 with their HUD`, () => {
      const g = fight(size);
      const w = g.m.wram;
      expect(w[0x56], 'the fight').toBe(0x1a);
      expect(teamSize(g.m)).toBe(size);
      const all = pages(g.m);
      expect(all.length).toBe(2 * size);
      // every wrestler in, three or four a side, distinct characters (the extras: nobody's pick)
      for (const p of all) expect((w[p]! & 0x80) !== 0 && w[p + 0x76] !== 0, p.toString(16)).toBe(true);
      expect(all.filter((p) => w[p + 0x17d] === 0).length).toBe(size);
      expect(new Set(all.map((p) => w[p + 0x01])).size).toBe(2 * size);
      // pad 1's team (side 0): its extras are the characters pad 1 picked, the CPU's are not
      const picked = picks(g.m, 0, size - 2);
      expect(picked.every((p) => p >= 0)).toBe(true);
      expect(picked.map((p, k) => [cursorCharacter(g.m, p), w[EXTRA[2 * k]! + 0x01]])).toEqual(picked.map((p) => [cursorCharacter(g.m, p), cursorCharacter(g.m, p)]));
      expect(picks(g.m, 1, size - 2).every((p) => p < 0)).toBe(true);
      // the extras' partner is a teammate, their opponents on the other side
      for (const p of all.slice(4)) {
        const rd = (a: number) => w[a]! | (w[a + 1]! << 8);
        expect(w[rd(p + 0xa5) + 0x17d]).toBe(w[p + 0x17d]);
        expect(w[rd(p + 0xa7) + 0x17d]).not.toBe(w[p + 0x17d]);
      }
      const r = new Renderer(g.m, 400);
      r.attach();
      const life = all.slice(4).map((p) => w[p + 0x79]!);
      let second = 0;
      let bank2 = false;
      for (let f = 0; f < 600; f++) {
        g.step([pad(0, f), 0, 0, 0]);
        second = Math.max(second, g.m.oamExtCount);
        bank2 ||= Array.from(g.m.oamx).some((v) => (v & 4) !== 0);
      }
      expect(all.slice(4).some((p, k) => w[p + 0x79]! < life[k]!), 'an extra was hit').toBe(true);
      expect(bank2, 'extra wrestlers drawn from bank 2').toBe(true);
      expect(second, 'pieces in the second OAM').toBeGreaterThan(0);
      expect(g.m.hudxRows, 'the extras HUD panels').toBe(4);
      // the extras' faces and names are their characters' portrait blocks
      expect(g.m.hudxTiles.subarray(0, 0x100).some((v) => v !== 0)).toBe(true);
    }, 120_000);
  }

  it('3 VS 3: a time over judges the teams with the extras life', () => {
    const g = fight(3);
    const w = g.m.wram;
    // team A's base wrestlers weaker, its extra full; team B the other way round
    const sideA = (p: number) => w[p + 0x17d] === w[0x800 + 0x17d];
    for (const p of pages(g.m)) w[p + 0x79] = p >= EXTRA[0] ? (sideA(p) ? 255 : 10) : sideA(p) ? 60 : 90;
    w[0x1a71] = 0;
    w[0x1a70] = 2;
    let state = 0;
    for (let f = 0; f < 1500 && state !== 0x20 && state !== 0x22; f++) {
      g.step([0, 0, 0, 0]);
      state = w[0x56]!;
    }
    expect(state.toString(16), "pad 1's team (A) won").toBe('20');
    for (const p of pages(g.m)) expect(w[p]!, p.toString(16)).toBe(sideA(p) ? 0x80 : 1);
  }, 120_000);

  it('4 VS 4: a rollback restores the extras, the second OAM and the HUD panels', () => {
    const start = fights.get(4)!;
    const frames = 240;
    const straight = fight(4);
    for (let f = 0; f < frames; f++) straight.step([pad(0, f), pad(1, f), 0, 0]);

    const g = fight(4);
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
    expect(start.length).toBe(g.m.stateSize);
  }, 120_000);
});
