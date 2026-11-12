/**
 * Three humans and 4 VS 4 (menu.ts, select.ts), from power-on with a multitap: pads 2 and 3
 * join on the Game Mode Select, which still offers the choice (the original skips it for
 * three or four); pad 3 alone on side 1 picks that side's extras and then its partner, shown
 * by name in the right margin; side 0 (pads 1 and 2) has nobody to pick, its extras get the
 * first free characters; nobody shares a character. Pad 3's marker stays on its picks.
 */
import { describe, expect, it } from 'vitest';
import { Game, HUDX_COLS, HUDX_ROWS, padsFromScript } from '@ssm/core';
import { installRules, teamArenaRules } from '../src/index.ts';
import { chosenTeamSize } from '../src/menu.ts';
import { cursorCharacter, picks } from '../src/select.ts';
import { BASE, EXTRA } from '../src/slots.ts';
import { haveRom, loadRom } from '../../core/test/fixture.ts';

const steps = (s: string) =>
  s.split(' ').flatMap((t) => {
    const [step, n] = t.split('*');
    return Array<string>(Number(n)).fill(step!);
  });
/** to the Game Mode Select, pads 2 and 3 join, 4 VS 4 (ssm-disasm inputs/R-mt3team-1.txt) */
const MENU = steps('wait*649 start*4 wait*60 start*4 wait*220 2start*4 wait*30 3start*4 wait*30 right*4 wait*30 right*4 wait*30 right*4 wait*60 y*4');
/** from the player select: each picks, pad 3 confirms two extras and its partner */
const SELECT = steps('wait*80 y*4 wait*30 2y*4 wait*30 3y*4 wait*40 3right*4 wait*20 3y*4 wait*40 3right*4 wait*20 3y*4 wait*40 3y*4');

/** A panel's text in the select screen's font (top tiles), row by row. */
function panelText(g: Game, panel: number): string[] {
  const font: Record<number, string> = {};
  [0x17, 0x19, 0x1b, 0x23, 0x25, 0x28, 0x2a].forEach((t, k) => (font[t] = String.fromCharCode(0x41 + k)));
  for (let k = 7; k < 26; k++) font[0x60 + 2 * (k - 7)] = String.fromCharCode(0x41 + k);
  const rows: string[] = [];
  for (let row = 0; row < HUDX_ROWS; row++) {
    let s = '';
    for (let col = 0; col < HUDX_COLS; col++) {
      const a = 2 * ((panel * HUDX_ROWS + row) * HUDX_COLS + col);
      s += font[(g.m.hudxMap[a]! | (g.m.hudxMap[a + 1]! << 8)) & 0x3ff] ?? '';
    }
    if (s) rows.push(s);
  }
  return rows;
}

describe.skipIf(!haveRom())('the extras picked on the player select', () => {
  it('three humans, 4 VS 4: pad 3 picks its side two extras, side 0 gets the first free', () => {
    const g = new Game(loadRom());
    installRules(g, teamArenaRules);
    g.powerOn();
    g.m.multitap = true;
    const w = g.m.wram;
    const state = () => w[0x56]!;
    for (let f = 0; f < MENU.length || state() !== 0x0c; f++) g.step(padsFromScript(MENU[f] ?? 'wait'));
    expect(w[0x1ba4], 'three humans').toBe(3);
    expect(chosenTeamSize(g.m)).toBe(4);
    // pad 3's marker ("3P" / "COM", C20A42) stays on each extra it picked: its copies (side 1's
    // at 6280 / 62C0) are drawn at the picks' x, while it waits for the partner's confirmation
    for (const s of SELECT.slice(0, -44)) g.step(padsFromScript(s));
    const extrasX = picks(g.m, 1, 2).map((p) => g.m.rom.u8(0xc0c9f1 + p));
    expect([0x6280, 0x62c0].map((d) => g.m.wram[d + 0x07])).toEqual(extrasX);
    expect(g.m.wram[0x6280 + 0x02], 'a copy of pad 3 (2)').toBe(2);
    for (const s of SELECT.slice(-44)) g.step(padsFromScript(s));
    const side1 = picks(g.m, 1, 2);
    expect(side1.every((p) => p >= 0)).toBe(true);
    expect(picks(g.m, 0, 2)).toEqual([-1, -1]);
    // the right margin names them (BIFF .. SCORP: the game's own names)
    const names = side1.map((p) => {
      let at = 0xc08a37;
      for (let k = 0; k < cursorCharacter(g.m, p); k++) at += 5 + g.m.rom.u8(at);
      return Array.from({ length: g.m.rom.u8(at) }, (_, k) => String.fromCharCode(g.m.rom.u8(at + 4 + k))).join('');
    });
    expect(panelText(g, 1)).toEqual(names);
    expect(panelText(g, 0)).toEqual([]);
    // the match: side 1's extras (6A00, 6E00) are pad 3's picks, everyone distinct
    for (let k = 0; k < 2400 && state() !== 0x1a; k++) g.step([0, 0, 0, 0]);
    for (let k = 0; k < 10; k++) g.step([0, 0, 0, 0]);
    expect([w[EXTRA[1] + 0x01], w[EXTRA[3] + 0x01]]).toEqual(side1.map((p) => cursorCharacter(g.m, p)));
    const all = [...BASE, ...EXTRA].map((p) => w[p + 0x01]);
    expect(new Set(all).size).toBe(8);
    for (const p of [...BASE, ...EXTRA]) expect(w[p]! & 0x80, p.toString(16)).toBe(0x80);
  }, 120_000);
});
