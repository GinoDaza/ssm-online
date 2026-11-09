/**
 * The wide picture of team matches in the singles arena (Ruleset.screenWidth > 256): the
 * renderer shows `Machine.wide` more pixels on each side of the SNES screen, and the game is
 * told that its screen reaches that far. The game's screen is the 256 columns from the camera
 * x (`$1A84`); everything below is in its coordinates, with M = the margin.
 *
 * - Culls: whatever lies outside the screen is not drawn. Each test is `x + a < b` (ADC #a,
 *   CMP #b, then BCS): the wrestlers C12318, the items C20367, the pool objects C2000C, the
 *   lamps and others C21053 / C21625 / C216AB, and each sprite piece C1F929 (-16..254). The CMP
 *   becomes `x + a + M < b + 2M`.
 * - Real sprite x: a piece that passes C1F929 is the next OAM entry (`$F4`) with x in `$2E`
 *   (C1F8D5); its x goes to Machine.oamWideXNext and `oamx` bit 1 (committed with the OAM).
 * - Screen pull C18E49: a wrestler beyond 10..F0 of the camera target `$1A8A` is put back at
 *   that edge (or held by its partner); the range becomes 10 - M .. F0 + M.
 * - Off-screen arrows (C217C4, object 4A): a wrestler beyond the screen gets an arrow at its
 *   edge (C21808: x - `$1A84` negative or past FF; +07 = 20 / E0); here beyond -M .. FF + M,
 *   with the arrow at 20 - M / E0 + M.
 * - The camera (camera.ts) frames and clamps the wide screen.
 *
 * The margin is set at the match start (C02631, team matches) and cleared when the arena
 * objects are gone (sprites.ts), so menus and singles keep the SNES picture.
 */
import type { Machine, Runner } from '@ssm/core';

const CULLS = [0xc1231b, 0xc2000f, 0xc2036a, 0xc21056, 0xc21628, 0xc216ae] as const;
const PIECE_CULL = 0xc1f92c;
const PULL_TEST = 0xc18e51;
const PULL_RIGHT = 0xc18e72;
const PULL_LEFT = 0xc18e99;

/** The margin of a ruleset's screen width. */
export const marginOf = (screenWidth: number) => Math.max(0, (screenWidth - 256) >> 1);

/** CMP #b (16-bit A) as if the screen were M wider on each side: compares A + M with b + 2M. */
function cmpWide(c: Machine, pc: number): number {
  const m = c.wide;
  const b = c.rom.u8(pc + 1) | (c.rom.u8(pc + 2) << 8);
  const a = (c.a + m) & 0xffff;
  const r = a - (b + 2 * m);
  c.tick(3 * c.fast);
  c.c = r >= 0;
  c.z = (r & 0xffff) === 0;
  c.n = (r & 0x8000) !== 0;
  return (pc & 0xff0000) | ((pc + 3) & 0xffff);
}

export function installWide(r: Runner): void {
  // C21808 SEP #$30 with A = the wrestler's x - $1A84; then BMI left / XBA BEQ on screen
  r.split(0xc2180a);
  r.override(0xc21808, (c) => {
    if (!c.wide) return r.original(c, 0xc21808);
    c.tick(3 * c.fast);
    const d = ((c.a & 0xffff) << 16) >> 16;
    c.setP(c.p | 0x30);
    if (d >= -c.wide && d < 0x100 + c.wide) return 0xc21822; // RTS: on screen
    return d < 0 ? 0xc21815 : 0xc2180f;
  });
  // C2181A LDY $02, after +07 = 20 / E0 (8-bit store): the arrow at the wide edge
  r.split(0xc2181c);
  r.override(0xc2181a, (c) => {
    if (c.wide) {
      const at = c.d + 0x07;
      const x = c.wram[at] === 0x20 ? 0x20 - c.wide : 0xe0 + c.wide;
      c.wram[at] = x & 0xff;
      c.wram[at + 1] = (x >> 8) & 0xff;
    }
    return r.original(c, 0xc2181a);
  });

  for (const pc of CULLS) {
    r.split((pc & 0xff0000) | ((pc + 3) & 0xffff));
    r.override(pc, (c) => (c.wide ? cmpWide(c, pc) : r.original(c, pc)));
  }

  r.split(PIECE_CULL + 3);
  r.override(PIECE_CULL, (c) => {
    if (!c.wide) return r.original(c, PIECE_CULL);
    const next = cmpWide(c, PIECE_CULL);
    const i = c.wram[0xf4]! & 0x7f;
    if (!c.c) {
      c.oamWideXNext[i] = ((c.a - 0x10) << 16) >> 16;
      c.oamxNext[i]! |= 2;
    }
    return next;
  });

  // C18E51 BMI after A = x - $1A8A: in range -> C18EA3 (no pull), past the right -> C18E58,
  // past the left -> C18E81
  r.split(0xc18e53);
  r.override(PULL_TEST, (c) => {
    if (!c.wide) return r.original(c, PULL_TEST);
    c.tick(2 * c.fast);
    const d = ((c.a & 0xffff) << 16) >> 16;
    if (d >= 0xf0 + c.wide) return 0xc18e58;
    if (d < 0x10 - c.wide) return 0xc18e81;
    return 0xc18ea3;
  });
  for (const [pc, v] of [
    [PULL_RIGHT, (c: Machine) => 0xf0 + c.wide],
    [PULL_LEFT, (c: Machine) => 0x10 - c.wide],
  ] as const) {
    r.split(pc + 3);
    r.override(pc, (c) => {
      if (!c.wide) return r.original(c, pc);
      c.tick(3 * c.fast);
      const a = v(c) & 0xffff;
      c.a = a;
      c.n = (a & 0x8000) !== 0;
      c.z = a === 0;
      return pc + 3;
    });
  }
}
