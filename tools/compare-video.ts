/**
 * Render the translated game from an oracle dump and compare each frame's picture with the
 * emulator's, pixel for pixel (diagnostic). The dump needs --video:
 *   python3 tools/oracle/dump.py --core trace --video --input match1 --start 2830 --frames 600 --full --out fixtures/match1-2830-trace
 *   npx tsx tools/compare-video.ts match1-2830-trace 600 [png-dir]
 * With a directory, writes ours / emulator / diff PNGs of the first differing frame there.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { Game, HEIGHT, Renderer, WIDTH, padsFromScript } from '@ssm/core';
import { loadFixture, loadRom } from '../packages/core/test/fixture.ts';

const name = process.argv[2] ?? 'match1-2830-trace';
const fx = loadFixture(name);
const N = Math.min(fx.frames, Number(process.argv[3] ?? fx.frames));
const g = new Game(loadRom());
if (!fx.ppu) throw new Error(`${name}: no picture, make the dump again with --video`);
g.seed(fx.record(0), fx.cpu(0)!, fx.ppu);
const r = new Renderer(g.m);
r.attach();
const px = WIDTH * HEIGHT;

function png(path: string, pixels: Uint16Array): void {
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const p = pixels[y * WIDTH + x]!;
      const o = y * (WIDTH * 3 + 1) + 1 + 3 * x;
      raw[o] = (p >> 11) << 3;
      raw[o + 1] = ((p >> 5) & 63) << 2;
      raw[o + 2] = (p & 31) << 3;
    }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let c = ~0;
    for (const b of td) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(~c >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

let bad = 0;
let first = -1;
for (let f = 0; f < N; f++) {
  g.step(padsFromScript(fx.pads[f] ?? 'wait'));
  const want = fx.picture(f + 1)!;
  let n = 0;
  let firstAt = -1;
  for (let i = 0; i < px; i++) if (r.pixels[i] !== want[i]) { n++; if (firstAt < 0) firstAt = i; }
  if (n) {
    bad++;
    if (first < 0) {
      first = f;
      const dir = process.argv[4];
      if (dir) {
        mkdirSync(dir, { recursive: true });
        png(`${dir}/ours.png`, r.pixels);
        png(`${dir}/emulator.png`, want);
        png(`${dir}/diff.png`, r.pixels.map((p, i) => (p === want[i] ? 0 : 0xffff)));
      }
    }
    if (bad <= 5) console.log(`frame ${f + 1}: ${n} pixels differ, first at x ${firstAt % WIDTH} y ${Math.trunc(firstAt / WIDTH)}: ${r.pixels[firstAt]!.toString(16)} / ${want[firstAt]!.toString(16)}`);
  }
}
console.log(bad ? `${bad} of ${N} frames differ (first ${first + 1})` : `all ${N} frames match`);
