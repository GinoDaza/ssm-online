/** The ROM image (USA, HiROM, no header), addressed by file offset or 24-bit CPU address. */

export const ROM_SIZE = 0x300000;
export const ROM_SHA1 = 'df427b086f61af56424a0a2fa912c82b2587bcb8';

/** File offset of a CPU address. Throws for addresses that do not map to ROM. */
export function romOffset(addr: number): number {
  const bank = (addr >>> 16) & 0xff;
  const lo = addr & 0xffff;
  if (bank >= 0xc0 || (bank >= 0x40 && bank < 0x7e)) return addr & 0x3fffff;
  if ((bank < 0x40 || (bank >= 0x80 && bank < 0xc0)) && lo >= 0x8000) return ((bank & 0x3f) << 16) | lo;
  throw new Error(`not a ROM address: ${addr.toString(16)}`);
}

export class RomImage {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    if (bytes.length !== ROM_SIZE) throw new Error(`ROM size ${bytes.length}, expected ${ROM_SIZE}`);
    this.bytes = bytes;
  }

  fileU8(off: number): number {
    return this.bytes[off]!;
  }

  u8(addr: number): number {
    return this.bytes[romOffset(addr)]!;
  }
}
