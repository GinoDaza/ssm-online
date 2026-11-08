/** Local controls -> SNES pad words: the keyboard is pad 1, gamepads are pads 1-4 in order. */
import { PAD } from '@ssm/core';

/** Keyboard layout of pad 1 (KeyboardEvent.code). */
export const KEYS: Record<string, number> = {
  ArrowUp: PAD.UP,
  ArrowDown: PAD.DOWN,
  ArrowLeft: PAD.LEFT,
  ArrowRight: PAD.RIGHT,
  KeyZ: PAD.B,
  KeyX: PAD.A,
  KeyA: PAD.Y,
  KeyS: PAD.X,
  KeyQ: PAD.L,
  KeyW: PAD.R,
  Enter: PAD.START,
  ShiftRight: PAD.SELECT,
};

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

  /** The four pad words now. */
  read(): number[] {
    const pads = [this.keys, 0, 0, 0];
    let k = 0;
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp || k > 3) continue;
      let w = 0;
      gp.buttons.forEach((b, i) => {
        if (b.pressed) w |= GAMEPAD[i] ?? 0;
      });
      const [x = 0, y = 0] = gp.axes;
      if (x < -0.5) w |= PAD.LEFT;
      if (x > 0.5) w |= PAD.RIGHT;
      if (y < -0.5) w |= PAD.UP;
      if (y > 0.5) w |= PAD.DOWN;
      pads[k] = pads[k]! | w;
      k++;
    }
    return pads;
  }
}
