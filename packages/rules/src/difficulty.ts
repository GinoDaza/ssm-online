/**
 * The default difficulty (Ruleset.difficulty, docs/changes/difficulty.md). The boot routine
 * C0120B validates the records at $0300-$03C4 and, when they fail (always on power-on: there is
 * no SRAM here), copies the 197 defaults C0:9DE9-9EAD over them (C01313-C0131E), with the
 * OPTION difficulty $03B0 = 3 (of 0-7). Both paths meet at C01320; the default path leaves the
 * 8-bit X at 0 (the copy's DEX loop), the valid one at BE (the records' end, $03BE). There this
 * writes the ruleset's level, so the OPTION screen shows it and still changes it.
 *
 * The level picks the first match's rank C0:ABA1[$03B0] (00 18 30 48 60 78 90 A8), and the CPU
 * level $1B63 = rank >> 3 (damage column +7A, AI rows): 3 -> 9, 5 -> 15.
 */
import type { Runner } from '@ssm/core';

const DIFFICULTY = 0x03b0;
/** the original's default (C0:9E99) */
export const ORIGINAL_DIFFICULTY = 3;

export function installDifficulty(r: Runner, level: number): void {
  r.override(0xc01320, (c) => {
    if ((c.x & 0xff) === 0) c.wram[DIFFICULTY] = level;
    return r.original(c, 0xc01320);
  });
}
