# Default difficulty two levels up

The OPTION difficulty starts at 5 of 0-7 instead of 3, in every mode, so the CPU starts at
level 15 instead of 9. The OPTION screen shows the new level and still changes it.

- **Ruleset:** `difficulty` (the level at power-on; the original's is 3, and 3 installs nothing).
  Classic and the full arena both use 5.
- **Code:** `rules/src/difficulty.ts`
- **Tests:** `rules/test/difficulty.test.ts`

## How

At power-on the boot routine C0120B checks the records at `$0300-$03C4` (scores, names, options).
With no SRAM they always fail, and C01313-C0131E copies the 197 defaults C0:9DE9-9EAD over them.
That puts the difficulty `$03B0` at 3. Both paths meet at C01320. The default path leaves the
8-bit X at 0 (the copy's DEX loop) and the valid one at BE, so the override at C01320 writes the
ruleset's level only after the copy.

The first match's rank is C0:ABA1[`$03B0`] (`00 18 30 48 60 78 90 A8`) and the CPU level
`$1B63` is rank >> 3. That level goes to every CPU wrestler's `+7A`, the damage column and the
AI's difficulty rows, and to the extras of 3 vs 3 and 4 vs 4 (`teams.ts`, C06E7E). Level 3
gives 9 and level 5 gives 15. The campaign then raises the rank from the way the human plays,
as in the original.
