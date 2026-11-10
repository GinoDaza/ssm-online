/**
 * Local controls -> pad words: the keyboard is pad 1, gamepads are pads 1-4 in order, then
 * players 5-8 (3 vs 3 / 4 vs 4: Game.step's words 5-8).
 */
import { PAD } from '@ssm/core';

/**
 * Keyboard layout of pad 1 (KeyboardEvent.code). The game uses few buttons: Y attacks, B
 * jumps, A pins (next to a downed opponent), START confirms and pauses.
 */
export const KEYS: Record<string, number> = {
  KeyW: PAD.UP,
  KeyS: PAD.DOWN,
  KeyA: PAD.LEFT,
  KeyD: PAD.RIGHT,
  KeyK: PAD.Y,
  Space: PAD.B,
  KeyE: PAD.A,
  Enter: PAD.START,
};

/** What each key does, for the menu. */
export const KEY_HELP: [string, string][] = [
  ['W A S D', 'move'],
  ['K', 'attack'],
  ['Space', 'jump'],
  ['E', 'pin'],
  ['Enter', 'start / pause'],
];

/** Standard gamepad buttons (W3C mapping) -> SNES, by position: bottom B, right A, left Y, top X. */
const GAMEPAD = [PAD.B, PAD.A, PAD.Y, PAD.X, PAD.L, PAD.R, 0, 0, PAD.SELECT, PAD.START, 0, 0, PAD.UP, PAD.DOWN, PAD.LEFT, PAD.RIGHT];

export class Controls {
  private keys = 0;
  private readonly down = (e: KeyboardEvent) => this.key(e, true);
  private readonly up = (e: KeyboardEvent) => this.key(e, false);

  attach(): void {
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    window.addEventListener('blur', () => (this.keys = 0));
  }

  detach(): void {
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
  }

  private key(e: KeyboardEvent, pressed: boolean): void {
    const bit = KEYS[e.code];
    if (bit === undefined) return;
    e.preventDefault();
    this.keys = pressed ? this.keys | bit : this.keys & ~bit;
  }

  /** The pad words now, as Game.step takes them: pads 1-5 (5 unused), players 5-8. */
  read(): number[] {
    const pads = [this.keys, 0, 0, 0, 0, 0, 0, 0, 0];
    let k = 0;
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp || k > 7) continue;
      let w = 0;
      gp.buttons.forEach((b, i) => {
        if (b.pressed) w |= GAMEPAD[i] ?? 0;
      });
      const [x = 0, y = 0] = gp.axes;
      if (x < -0.5) w |= PAD.LEFT;
      if (x > 0.5) w |= PAD.RIGHT;
      if (y < -0.5) w |= PAD.UP;
      if (y > 0.5) w |= PAD.DOWN;
      const word = k < 4 ? k : k + 1;
      pads[word] = pads[word]! | w;
      k++;
    }
    return pads;
  }
}
