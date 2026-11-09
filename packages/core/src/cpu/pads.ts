/** Input-script buttons (ssm-disasm inputs/*.txt, one step per frame) -> SNES pad words. */
import { PAD } from '../input.ts';

const NAMES: Record<string, number> = {
  b: PAD.B,
  y: PAD.Y,
  select: PAD.SELECT,
  start: PAD.START,
  up: PAD.UP,
  down: PAD.DOWN,
  left: PAD.LEFT,
  right: PAD.RIGHT,
  a: PAD.A,
  x: PAD.X,
  l: PAD.L,
  r: PAD.R,
};

/** "right+2a" -> [0x0100, 0x0080, 0, 0, 0] (a digit prefix picks the pad, default pad 1). */
export function padsFromScript(step: string): number[] {
  const pads = [0, 0, 0, 0, 0];
  if (step === 'wait' || step === '' || step === 'multitap') return pads; // multitap: plugsMultitap
  for (const b of step.split('+')) {
    const k = /^[1-5]/.test(b) ? Number(b[0]) - 1 : 0;
    const name = b.replace(/^[1-5]/, '');
    const bit = NAMES[name];
    if (bit === undefined) throw new Error(`unknown button ${b}`);
    pads[k]! |= bit;
  }
  return pads;
}

/** The script step that plugs a multitap into controller port 2 (then runs as a wait). */
export function plugsMultitap(step: string): boolean {
  return step === 'multitap';
}
