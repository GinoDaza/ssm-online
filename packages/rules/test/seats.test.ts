/**
 * Seats (seats.ts): players numbered team by team, each seat a pad; the lobby's team size comes
 * up first on the Game Mode Select; two humans seated P1 and P3 (pads 1 and 3, the multitap)
 * fight each other, each with a CPU partner.
 */
import { describe, expect, it } from 'vitest';
import { Game, PAD, padsFromScript } from '@ssm/core';
import { installRules, playerNumber, presetTeamSize, seatSlot, teamArenaRules } from '../src/index.ts';
import { chosenTeamSize } from '../src/menu.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

const TO_MENU = 'wait*650 start*4 wait*60 start*4 wait*240'.split(' ').flatMap((t) => {
  const [s, n] = t.split('*');
  return Array<string>(Number(n)).fill(s!);
});

describe('seats', () => {
  it('numbers players team by team, pad 1 first', () => {
    // 3 VS 3: P1-P3 are pads 1, 2 and player 5; P4-P6 pads 3, 4 and player 6
    expect([0, 1, 2].map((p) => seatSlot(3, 0, p))).toEqual([0, 1, 4]);
    expect([0, 1, 2].map((p) => seatSlot(3, 1, p))).toEqual([2, 3, 5]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((s) => playerNumber(4, s))).toEqual([1, 2, 5, 6, 3, 7, 4, 8]);
    expect([0, 1, 2, 3].map((s) => playerNumber(2, s))).toEqual([1, 2, 3, 4]);
    // a single match: pad 1 against pad 2
    expect([seatSlot(1, 0, 0), seatSlot(1, 1, 0)]).toEqual([0, 1]);
  });

  it.skipIf(!haveRom())('the Game Mode Select comes up on the preset team size', () => {
    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
    g.powerOn();
    presetTeamSize(g.m, 3);
    for (const s of TO_MENU) g.step(padsFromScript(s).slice(0, 4));
    expect(g.m.wram[0x56]).toBe(4);
    expect(chosenTeamSize(g.m)).toBe(3);
  }, 60_000);

  it.skipIf(!haveRom())('P1 and P3 (pads 1 and 3) are on opposite teams', () => {
    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
    g.powerOn();
    g.m.multitap = true;
    presetTeamSize(g.m, 2);
    const w = g.m.wram;
    const state = () => w[0x56]!;
    for (const s of TO_MENU) g.step(padsFromScript(s).slice(0, 4));
    const press = (p1: number, p3: number) => {
      for (let k = 0; k < 4; k++) g.step([p1, 0, p3, 0]);
      for (let k = 0; k < 30; k++) g.step([0, 0, 0, 0]);
    };
    press(0, PAD.START); // pad 3 joins
    press(PAD.Y, 0); // 2 VS 2
    for (let k = 0; k < 1500 && state() !== 0x0c; k++) g.step([0, 0, 0, 0]);
    for (let k = 0; k < 80; k++) g.step([0, 0, 0, 0]);
    press(PAD.Y, PAD.Y); // their wrestlers
    press(PAD.RIGHT, PAD.RIGHT);
    press(PAD.Y, PAD.Y); // their CPU partners
    for (let k = 0; k < 3000 && state() !== 0x1a; k++) g.step([0, 0, 0, 0]);
    const side = (pad: number) => [0x800, 0xa00, 0xc00, 0xe00].map((p) => (w[p + 0x77] === pad ? w[p + 0x17d] : -1)).find((v) => v! >= 0);
    expect(side(1)).toBe(0);
    expect(side(3)).toBe(1);
  }, 120_000);
});
