/**
 * Game modes. The translated game is the original; a Ruleset says where a mode departs from
 * it, and the routines it touches are replaced by TypeScript overrides that read it
 * (overrides.ts, docs/architecture.md). Classic must change nothing.
 */
export interface Ruleset {
  readonly id: string;
  /** shown in the menus */
  readonly label: string;
  /** fighters in a team match (original 4; singles are always 2) */
  readonly fighters: number;
  /**
   * Team matches in the singles environment: the singles arena (with the floor around the
   * ring and the front crowd), its camera, the ringside items and the ring exits. The team
   * logic stays (four wrestlers, partners and targets, HUD, judge). Original: false, the team
   * arena ends at the ring and nobody leaves it.
   */
  readonly singlesArena: boolean;
  /** playfield width in pixels (original 256) */
  readonly screenWidth: number;
  /**
   * The match picture fills the screen's 224 lines (original false: 184, lines 31-214, black
   * above and below).
   */
  readonly fullHeight: boolean;
  /**
   * Singles matches get the same picture as the team matches of this mode (screenWidth,
   * fullHeight) and its camera (camera.ts). Original: false, the SNES picture.
   */
  readonly wideSingles: boolean;
  /**
   * The Game Mode Select offers 1 VS 1 to 4 VS 4 (menu.ts). Original: false, SINGLE MATCH or
   * TEAM BATTLE ROYAL.
   */
  readonly modeMenu: boolean;
}
