/**
 * The margins' own tiles (Machine.marginTiles, Margin.OWN), an extension the original never
 * uses: a layer whose margins are OWN shows its map's entries there with the bank's tiles, the
 * SNES screen with VRAM's; the default (MAP) shows VRAM's everywhere.
 */
import { describe, expect, it } from 'vitest';
import { Machine, MARGIN_WORDS, Margin, ROM_SIZE, Renderer, RomImage } from '../src/index.ts';

/** BG2 in mode 1, a 64 x 32 map at B000 whose every entry is tile 1 (palette 2), tiles at C000 */
function machine(): Machine {
  const m = new Machine(new RomImage(new Uint8Array(ROM_SIZE)));
  m.ioreg[0x00] = 0x0f;
  m.ioreg[0x05] = 0x01;
  m.ioreg[0x08] = 0x59;
  m.ioreg[0x0b] = 0x60;
  m.ioreg[0x2c] = 0x02;
  for (let i = 0; i < 0x1000; i += 2) {
    m.vram[0xb000 + i] = 0x01;
    m.vram[0xb000 + i + 1] = 0x08;
  }
  // VRAM's tile 1: colour 1 (plane 0); the bank's: colour 2 (plane 1)
  for (let y = 0; y < 8; y++) {
    m.vram[0xc020 + 2 * y] = 0xff;
    m.marginTiles[0x20 + 2 * y + 1] = 0xff;
  }
  // colours 33 and 34: red and green
  m.cgram.set([0x1f, 0x00, 0xe0, 0x03], 2 * 33);
  m.wide = 72;
  return m;
}

const RED = 31 << 11;
const GREEN = 63 << 5;

describe('the margins\' own tiles', () => {
  it('OWN: the margins show the bank\'s tiles, the SNES screen VRAM\'s; MAP: VRAM\'s everywhere', () => {
    for (const mode of [Margin.MAP, Margin.OWN]) {
      const m = machine();
      m.margins[MARGIN_WORDS * 1] = mode;
      const r = new Renderer(m, 400);
      r.line(10);
      const at = (x: number) => r.pixels[10 * 400 + x];
      const margin = mode === Margin.OWN ? GREEN : RED;
      expect([at(0), at(71), at(72), at(327), at(328), at(399)]).toEqual([margin, margin, RED, RED, margin, margin]);
    }
  });
});
