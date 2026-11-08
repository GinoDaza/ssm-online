/** SNES joypad word, as the controller registers report it (and $B0.. in WRAM hold it). */
export const PAD = {
  B: 0x8000,
  Y: 0x4000,
  SELECT: 0x2000,
  START: 0x1000,
  UP: 0x0800,
  DOWN: 0x0400,
  LEFT: 0x0200,
  RIGHT: 0x0100,
  A: 0x0080,
  X: 0x0040,
  L: 0x0020,
  R: 0x0010,
} as const;

export type PadButton = keyof typeof PAD;
