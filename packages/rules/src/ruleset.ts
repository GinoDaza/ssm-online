/**
 * Game modes. The translated game is the original; a Ruleset says where a mode departs from
 * it, and the routines it touches are replaced by TypeScript overrides that read it
 * (Runner.overrides, docs/architecture.md). Classic must change nothing.
 */
export interface Ruleset {
  readonly id: string;
  /** shown in the menus */
  readonly label: string;
  /** fighters in the match (original: 2 singles, 4 team) */
  readonly fighters: number;
  /** playfield width in pixels (original 256) */
  readonly screenWidth: number;
  /** may a fighter leave the ring through the ropes? (original: singles only) */
  canLeaveRing(team: boolean): boolean;
}
