# Game Mode Select with 1 VS 1 to 4 VS 4

The Game Mode Select offers four choices, 1 VS 1, 2 VS 2, 3 VS 3 and 4 VS 4, instead of SINGLE
MATCH and TEAM BATTLE ROYAL.

- **Ruleset:** `modeMenu`. Classic leaves the original unchanged.
- **Code:** `rules/src/menu.ts`
- **Tests:** `rules/test/menu.test.ts`

## How

The original screen has two panels (SINGLE MATCH, TEAM BATTLE ROYAL) in BG1 with their backdrops
in BG2; this mode rebuilds them as four narrower panels (a 5 x 10 tile window of the singles
picture, three of the team one) with labels in the game's own font, and left / right move
between them. The choice is kept in `Machine.rulesWord` (a word the modes own, saved with the
state); 2 VS 2 and up set the team bit. With three or four humans the original skips the choice
(team play after a wait); here they choose too, from 2 VS 2 up. Classic keeps the original
screen (`rules/test/menu.test.ts`).
