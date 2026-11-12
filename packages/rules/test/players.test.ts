/**
 * Players 5-8 (players.ts), from power-on with a multitap and pad 1 alone: 4 VS 4; players 5
 * and 6 join on the entry screen (START), the selection waits for them while they pick in the
 * margins, their extras (6800, 6A00) are theirs in the match (+77 = 5 / 6) and move by their
 * pads, the CPU's extras ignore players 7-8's; a rollback session with six slots restores it.
 * Joining, moving and picking queue the pads 1-4's sounds; their buttons are the default
 * assignment's, whatever pad 1's options say.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Game, PAD, Rollback, checksum, padsFromScript } from '@ssm/core';
import { installRules, teamArenaRules } from '../src/index.ts';
import { cursorCharacter, picks } from '../src/select.ts';
import { joined } from '../src/players.ts';
import { BASE, EXTRA } from '../src/slots.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

const MENU = 'wait*650 start*4 wait*60 start*4 wait*220 right*4 wait*30 right*4 wait*30 right*4 wait*30 y*4'.split(' ').flatMap((t) => {
  const [s, n] = t.split('*');
  return Array<string>(Number(n)).fill(s!);
});

/** the sounds queued (C00B2C / C00B42 into 03E0) while `run` runs */
const sounds: number[] = [];
let listening = false;

/** pads: pad 1, then players 5-8 */
const step = (g: Game, p1: number, x: number[] = []) => {
  const w = g.m.wram;
  const from = w[0xfe]!;
  g.step([p1, 0, 0, 0, 0, ...x]);
  if (listening) for (let o = from; o !== w[0xfe]; o = (o + 2) & 0x1e) sounds.push(w[0x3e0 + o]!);
};
const heard = (run: () => void) => {
  sounds.length = 0;
  listening = true;
  run();
  listening = false;
  return [...sounds];
};

describe.skipIf(!haveRom())('players 5-8', () => {
  let fight: Uint8Array;
  let chosen: number[];
  let waited = false;
  const heardBy: Record<string, number[]> = {};

  beforeAll(() => {
    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
    g.powerOn();
    g.m.multitap = true;
    const w = g.m.wram;
    const state = () => w[0x56]!;
    for (const s of MENU) step(g, padsFromScript(s)[0]!);
    for (let k = 0; k < 40; k++) step(g, 0);
    // the entry: players 5 and 6 press START
    heardBy.join = heard(() => {
      for (let k = 0; k < 4; k++) step(g, 0, [PAD.START, PAD.START]);
    });
    for (let k = 0; k < 1500 && state() !== 0x0c; k++) step(g, 0);
    expect(state(), "the player select").toBe(0x0c);
    const press = (p1: number, x: number[] = []) => {
      for (let k = 0; k < 4; k++) step(g, p1, x);
      for (let k = 0; k < 30; k++) step(g, 0);
    };
    for (let k = 0; k < 80; k++) step(g, 0);
    press(PAD.Y); // pad 1's wrestler
    press(PAD.RIGHT);
    press(PAD.Y); // 7P's extra (5P's is player 5's)
    press(PAD.RIGHT);
    press(PAD.Y); // the partner
    for (let k = 0; k < 120; k++) step(g, 0);
    waited = state() === 0x0c;
    heardBy.move = heard(() => press(0, [PAD.RIGHT]));
    press(0, [PAD.RIGHT]);
    heardBy.pick = heard(() => press(0, [PAD.B])); // player 5
    press(0, [0, PAD.Y]); // player 6
    chosen = [...picks(g.m, 0, 2), ...picks(g.m, 1, 2)];
    for (let k = 0; k < 3000 && state() !== 0x1a; k++) step(g, 0);
    for (let k = 0; k < 900; k++) step(g, 0);
    fight = g.m.save();
  }, 180_000);

  const atFight = () => {
    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
    g.m.load(fight);
    return g;
  };

  it('join on the entry, pick in the margins, play their extras', () => {
    const g = atFight();
    const w = g.m.wram;
    expect([0, 1, 2, 3].map((e) => joined(g.m, e))).toEqual([true, true, false, false]);
    expect(waited, 'the selection waits for players 5-8').toBe(true);
    // side 0: player 5's pick, then pad 1's for 7P; side 1: player 6's, then none (the CPU's)
    expect(chosen.slice(0, 3).every((p) => p >= 0)).toBe(true);
    expect(chosen[3]).toBe(-1);
    expect(w[0x56]).toBe(0x1a);
    expect(EXTRA.map((p) => w[p + 0x77])).toEqual([5, 6, 0, 0]);
    expect([w[EXTRA[0] + 0x01], w[EXTRA[2] + 0x01], w[EXTRA[1] + 0x01]]).toEqual(chosen.slice(0, 3).map((p) => cursorCharacter(g.m, p)));
    expect(new Set([...BASE, ...EXTRA].map((p) => w[p + 0x01])).size).toBe(8);
  });

  it('joining, moving and picking make the select sounds', () => {
    expect(heardBy.join!.filter((s) => s === 0x04)).toHaveLength(2); // players 5 and 6, once each
    expect(heardBy.move).toContain(0x02);
    expect(heardBy.pick).toContain(0x03);
  });

  it("player 5's buttons are the default assignment's, not pad 1's options", () => {
    const held = (assignment?: number[]) => {
      const g = atFight();
      if (assignment) g.m.wram.set(assignment, 0x03b2);
      const out: number[] = [];
      for (const b of [PAD.Y, PAD.B, PAD.A, PAD.X, PAD.L, PAD.R]) {
        step(g, 0, [b]);
        out.push(g.m.wram[EXTRA[0] + 0x91]!);
        step(g, 0);
      }
      return out;
    };
    const def = held();
    expect(new Set(def).size, 'the buttons do different things').toBeGreaterThan(1);
    expect(held([0x20, 0x40, 0x80])).toEqual(def);
  }, 60_000);

  it("player 5's pad drives 6800, player 7's drives nobody", () => {
    const run = (x: number[]) => {
      const g = atFight();
      for (let f = 0; f < 120; f++) step(g, 0, x);
      return checksum(g.m.save());
    };
    const still = run([]);
    expect(run([PAD.LEFT]), 'player 5').not.toBe(still);
    expect(run([0, 0, PAD.LEFT | PAD.Y]), 'player 7: the CPU plays 6C00').toBe(still);
  }, 60_000);

  it('a rollback session with six slots (pad 1, players 5 and 6 late) ends where a straight run does', () => {
    const pad = (s: number, f: number) => [PAD.LEFT, PAD.RIGHT, PAD.Y, PAD.B, 0][((f >> 4) + s) % 5]!;
    const frames = 180;
    const straight = atFight();
    for (let f = 0; f < frames; f++) step(straight, pad(0, f), [pad(4, f), pad(5, f)]);
    const g = atFight();
    const session = new Rollback(g, { players: 6 });
    for (let f = 0; f < frames; f++) {
      for (const s of [0, 1, 2, 3]) session.addInput(s, f, s === 0 ? pad(0, f) : 0);
      if (f >= 3) for (const s of [4, 5]) session.addInput(s, f - 3, pad(s, f - 3)); // three frames late
      session.advance();
    }
    for (let f = frames - 3; f < frames; f++) for (const s of [4, 5]) session.addInput(s, f, pad(s, f));
    session.sync();
    expect(session.rollbacks).toBeGreaterThan(0);
    expect(checksum(g.m.save())).toBe(checksum(straight.m.save()));
  }, 60_000);
});
