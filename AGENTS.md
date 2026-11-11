# AGENTS.md

Saturday Night Slam Masters (SNES), playable online: the ROM's code is translated to
JavaScript at run time (`packages/core`), and new modes replace routines through overrides.
Read `README.md` and `docs/architecture.md` first; `docs/changes/` documents each change to
the original game.

## Commands

```sh
npm install
npm run dev          # server + client with hot reload, port 8790
npm start            # production build + server
npm run check        # typecheck, core purity check, tests
npx tsx tools/compare-frames.ts <dump> <frames>   # game vs emulator dump
```

## Rules

- Everything in the repository and the game is written in English. Reply to the user in
  their language.
- No game data in git: ROM, emulator dumps (`fixtures/`), `cache/`.
- `packages/core` must stay deterministic: integers only; no `Math.random`, clocks or
  platform APIs.
- Do not edit translated behaviour to fix a mode. Write an override at the routine's
  address that reads the `Ruleset`. Classic rules must leave the game unchanged.
- A change to the translator or the Machine needs a test against the original: captured
  calls or emulator dumps (`tools/oracle`). The sibling repo `../ssm-disasm` documents the
  ROM (`docs/notes.md`); use it to look up routines and addresses.
- Commits: `type(scope): summary` (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`).
