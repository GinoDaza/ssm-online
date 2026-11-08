/**
 * The S-DSP, ported from blargg's SPC_DSP (snes_spc 0.9.0, as built into the oracle's snes9x
 * core): the 32-step state machine per output sample, BRR decoding, Gaussian interpolation,
 * ADSR / GAIN envelopes, noise, pitch modulation and echo with its FIR filter. One step per
 * SPC clock; a sample (left, right) leaves every 32 clocks, at 32 kHz.
 *
 * State lives in plain fields and is copied to / from the Machine's state buffer by save() /
 * load() (STATE_WORDS words). The output samples are not state: they go to `out` when set.
 */

// envelope modes
const RELEASE = 0, ATTACK = 1, DECAY = 2, SUSTAIN = 3;

const BRR_BUF = 12;
const ECHO_HIST = 8;

// global registers
const R_MVOLL = 0x0c, R_EVOLL = 0x2c, R_KON = 0x4c, R_KOFF = 0x5c, R_FLG = 0x6c, R_ENDX = 0x7c;
const R_EFB = 0x0d, R_PMON = 0x2d, R_NON = 0x3d, R_EON = 0x4d, R_DIR = 0x5d, R_ESA = 0x6d, R_EDL = 0x7d;
const R_FIR = 0x0f;
// voice registers
const V_VOLL = 0, V_PITCHL = 2, V_PITCHH = 3, V_SRCN = 4, V_ADSR0 = 5, V_ADSR1 = 6, V_GAIN = 7, V_ENVX = 8, V_OUTX = 9;

const INITIAL_REGS = [
  0x45, 0x8b, 0x5a, 0x9a, 0xe4, 0x82, 0x1b, 0x78, 0x00, 0x00, 0xaa, 0x96, 0x89, 0x0e, 0xe0, 0x80,
  0x2a, 0x49, 0x3d, 0xba, 0x14, 0xa0, 0xac, 0xc5, 0x00, 0x00, 0x51, 0xbb, 0x9c, 0x4e, 0x7b, 0xff,
  0xf4, 0xfd, 0x57, 0x32, 0x37, 0xd9, 0x42, 0x22, 0x00, 0x00, 0x5b, 0x3c, 0x9f, 0x1b, 0x87, 0x9a,
  0x6f, 0x27, 0xaf, 0x7b, 0xe5, 0x68, 0x0a, 0xd9, 0x00, 0x00, 0x9a, 0xc5, 0x9c, 0x4e, 0x7b, 0xff,
  0xea, 0x21, 0x78, 0x4f, 0xdd, 0xed, 0x24, 0x14, 0x00, 0x00, 0x77, 0xb1, 0xd1, 0x36, 0xc1, 0x67,
  0x52, 0x57, 0x46, 0x3d, 0x59, 0xf4, 0x87, 0xa4, 0x00, 0x00, 0x7e, 0x44, 0x00, 0x4e, 0x7b, 0xff,
  0x75, 0xf5, 0x06, 0x97, 0x10, 0xc3, 0x24, 0xbb, 0x00, 0x00, 0x7b, 0x7a, 0xe0, 0x60, 0x12, 0x0f,
  0xf7, 0x74, 0x1c, 0xe5, 0x39, 0x3d, 0x73, 0xc1, 0x00, 0x00, 0x7a, 0xb3, 0xff, 0x4e, 0x7b, 0xff,
];

// prettier-ignore
const GAUSS = [
     0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,   0,
     1,   1,   1,   1,   1,   1,   1,   1,   1,   1,   1,   2,   2,   2,   2,   2,
     2,   2,   3,   3,   3,   3,   3,   4,   4,   4,   4,   4,   5,   5,   5,   5,
     6,   6,   6,   6,   7,   7,   7,   8,   8,   8,   9,   9,   9,  10,  10,  10,
    11,  11,  11,  12,  12,  13,  13,  14,  14,  15,  15,  15,  16,  16,  17,  17,
    18,  19,  19,  20,  20,  21,  21,  22,  23,  23,  24,  24,  25,  26,  27,  27,
    28,  29,  29,  30,  31,  32,  32,  33,  34,  35,  36,  36,  37,  38,  39,  40,
    41,  42,  43,  44,  45,  46,  47,  48,  49,  50,  51,  52,  53,  54,  55,  56,
    58,  59,  60,  61,  62,  64,  65,  66,  67,  69,  70,  71,  73,  74,  76,  77,
    78,  80,  81,  83,  84,  86,  87,  89,  90,  92,  94,  95,  97,  99, 100, 102,
   104, 106, 107, 109, 111, 113, 115, 117, 118, 120, 122, 124, 126, 128, 130, 132,
   134, 137, 139, 141, 143, 145, 147, 150, 152, 154, 156, 159, 161, 163, 166, 168,
   171, 173, 175, 178, 180, 183, 186, 188, 191, 193, 196, 199, 201, 204, 207, 210,
   212, 215, 218, 221, 224, 227, 230, 233, 236, 239, 242, 245, 248, 251, 254, 257,
   260, 263, 267, 270, 273, 276, 280, 283, 286, 290, 293, 297, 300, 304, 307, 311,
   314, 318, 321, 325, 328, 332, 336, 339, 343, 347, 351, 354, 358, 362, 366, 370,
   374, 378, 381, 385, 389, 393, 397, 401, 405, 410, 414, 418, 422, 426, 430, 434,
   439, 443, 447, 451, 456, 460, 464, 469, 473, 477, 482, 486, 491, 495, 499, 504,
   508, 513, 517, 522, 527, 531, 536, 540, 545, 550, 554, 559, 563, 568, 573, 577,
   582, 587, 592, 596, 601, 606, 611, 615, 620, 625, 630, 635, 640, 644, 649, 654,
   659, 664, 669, 674, 678, 683, 688, 693, 698, 703, 708, 713, 718, 723, 728, 732,
   737, 742, 747, 752, 757, 762, 767, 772, 777, 782, 787, 792, 797, 802, 806, 811,
   816, 821, 826, 831, 836, 841, 846, 851, 855, 860, 865, 870, 875, 880, 884, 889,
   894, 899, 904, 908, 913, 918, 923, 927, 932, 937, 941, 946, 951, 955, 960, 965,
   969, 974, 978, 983, 988, 992, 997,1001,1005,1010,1014,1019,1023,1027,1032,1036,
  1040,1045,1049,1053,1057,1061,1066,1070,1074,1078,1082,1086,1090,1094,1098,1102,
  1106,1109,1113,1117,1121,1125,1128,1132,1136,1139,1143,1146,1150,1153,1157,1160,
  1164,1167,1170,1174,1177,1180,1183,1186,1190,1193,1196,1199,1202,1205,1207,1210,
  1213,1216,1219,1221,1224,1227,1229,1232,1234,1237,1239,1241,1244,1246,1248,1251,
  1253,1255,1257,1259,1261,1263,1265,1267,1269,1270,1272,1274,1275,1277,1279,1280,
  1282,1283,1284,1286,1287,1288,1290,1291,1292,1293,1294,1295,1296,1297,1297,1298,
  1299,1300,1300,1301,1302,1302,1303,1303,1303,1304,1304,1304,1304,1304,1305,1305,
];

const COUNTER_RANGE = 2048 * 5 * 3;
// prettier-ignore
const COUNTER_RATES = [
  COUNTER_RANGE + 1, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80,
  64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1,
];
// prettier-ignore
const COUNTER_OFFSETS = [
  1, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536,
  0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 536, 0, 1040, 0, 0,
];

/** int16 wrap ((int16_t) v) */
function s16(v: number): number {
  return (v << 16) >> 16;
}

/** int8 of a register byte */
function s8(v: number): number {
  return (v << 24) >> 24;
}

function clamp16(v: number): number {
  return s16(v) !== v ? (v >> 31) ^ 0x7fff : v;
}

class Voice {
  /** decoded samples, twice over to simplify the wrap */
  readonly buf = new Int32Array(2 * BRR_BUF);
  bufPos = 0;
  /** fractional position in the sample (0x1000 = 1.0) */
  interpPos = 0;
  brrAddr = 0;
  brrOffset = 1;
  /** KON delay / setup phase */
  konDelay = 0;
  envMode = RELEASE;
  env = 0;
  hiddenEnv = 0;
  tEnvxOut = 0;
  /** first register of the voice */
  readonly reg: number;
  readonly vbit: number;

  constructor(n: number) {
    this.reg = n * 0x10;
    this.vbit = 1 << n;
  }
}

const VOICE_WORDS = 2 * BRR_BUF + 9;
/** state size in 32-bit words (save / load) */
export const DSP_STATE_WORDS = 64 + 8 * VOICE_WORDS + 2 * ECHO_HIST * 2 + 40;

export class Dsp {
  /** SPC clocks not yet run (the SMP adds, synchronize() runs them) */
  clock = 0;
  /** registers as the DSP sees them, and as the SMP reads them back */
  readonly regs = new Uint8Array(128);
  readonly xregs = new Uint8Array(128);
  readonly voices = Array.from({ length: 8 }, (_, n) => new Voice(n));
  /** echo history; twice over, read at echoHistPos + i */
  readonly echoHist = new Int32Array(2 * ECHO_HIST * 2);
  echoHistPos = 0;
  everyOtherSample = 1;
  kon = 0;
  noise = 0x4000;
  counter = 0;
  echoOffset = 0;
  echoLength = 0;
  /** next clock of the sample to run (0-31) */
  phase = 0;
  konCheck = 0;
  newKon = 0;
  endxBuf = 0;
  envxBuf = 0;
  outxBuf = 0;
  tPmon = 0;
  tNon = 0;
  tEon = 0;
  tDir = 0;
  tKoff = 0;
  tBrrNextAddr = 0;
  tAdsr0 = 0;
  tBrrHeader = 0;
  tBrrByte = 0;
  tSrcn = 0;
  tEsa = 0;
  tEchoEnabled = 0;
  tDirAddr = 0;
  tPitch = 0;
  tOutput = 0;
  tLooped = 0;
  tEchoPtr = 0;
  tMainOutL = 0;
  tMainOutR = 0;
  tEchoOutL = 0;
  tEchoOutR = 0;
  tEchoInL = 0;
  tEchoInR = 0;

  /** the samples (left, right, ...) go here when set; `outCount` values written */
  out: Int16Array | null = null;
  outCount = 0;

  readonly ram: Uint8Array;

  constructor(ram: Uint8Array) {
    this.ram = ram;
  }

  // ---- registers ---------------------------------------------------------------------------

  read(addr: number): number {
    this.synchronize();
    return this.xregs[addr]!;
  }

  write(addr: number, v: number): void {
    this.synchronize();
    this.regs[addr] = v;
    this.xregs[addr] = v;
    switch (addr & 0x0f) {
      case V_ENVX:
        this.envxBuf = v;
        break;
      case V_OUTX:
        this.outxBuf = v;
        break;
      case 0x0c:
        if (addr === R_KON) this.newKon = v;
        if (addr === R_ENDX) {
          // always cleared, whatever is written
          this.endxBuf = 0;
          this.regs[R_ENDX] = 0;
        }
        break;
    }
  }

  synchronize(): void {
    if (this.clock) {
      this.run(this.clock);
      this.clock = 0;
    }
  }

  /** Power-on (SPC_DSP::reset: load the initial registers). */
  reset(): void {
    this.xregs.set(INITIAL_REGS);
    this.regs.fill(0);
    this.regs[66] = 0x01;
    this.regs[82] = 0x01;
    this.regs[R_FLG] = 0xe0;
    for (const v of this.voices) {
      v.buf.fill(0);
      v.bufPos = 0;
      v.interpPos = 0;
      v.brrAddr = 0;
      v.brrOffset = 1;
      v.konDelay = 0;
      v.envMode = RELEASE;
      v.env = 0;
      v.hiddenEnv = 0;
      v.tEnvxOut = 0;
    }
    this.echoHist.fill(0);
    this.kon = 0;
    this.konCheck = 0;
    this.endxBuf = this.envxBuf = this.outxBuf = 0;
    this.tPmon = this.tNon = this.tEon = this.tKoff = 0;
    this.tBrrNextAddr = this.tAdsr0 = this.tBrrHeader = this.tBrrByte = this.tSrcn = 0;
    this.tEchoEnabled = this.tDirAddr = this.tPitch = this.tOutput = this.tLooped = this.tEchoPtr = 0;
    this.tMainOutL = this.tMainOutR = this.tEchoOutL = this.tEchoOutR = this.tEchoInL = this.tEchoInR = 0;
    this.echoLength = 0;
    this.newKon = this.regs[R_KON]!;
    this.tDir = this.regs[R_DIR]!;
    this.tEsa = this.regs[R_ESA]!;
    this.noise = 0x4000;
    this.echoHistPos = 0;
    this.everyOtherSample = 1;
    this.echoOffset = 0;
    this.phase = 0;
    this.counter = 0;
    this.clock = 0;
  }

  // ---- counters, envelope, BRR -------------------------------------------------------------

  private readCounter(rate: number): number {
    return (this.counter + COUNTER_OFFSETS[rate]!) % COUNTER_RATES[rate]!;
  }

  private interpolate(v: Voice): number {
    const i = (v.interpPos >> 12) + v.bufPos;
    const b = v.buf;
    const offset = (v.interpPos >> 4) & 0xff;
    const fwd = 255 - offset;
    let out = (GAUSS[fwd]! * b[i]!) >> 11;
    out += (GAUSS[fwd + 256]! * b[i + 1]!) >> 11;
    out += (GAUSS[offset + 256]! * b[i + 2]!) >> 11;
    out = s16(out);
    out += (GAUSS[offset]! * b[i + 3]!) >> 11;
    return clamp16(out) & ~1;
  }

  private runEnvelope(v: Voice): void {
    let env = v.env;
    if (v.envMode === RELEASE) {
      env -= 0x8;
      if (env < 0) env = 0;
      v.env = env;
      return;
    }
    let rate: number;
    let envData = this.regs[v.reg + V_ADSR1]!;
    if (this.tAdsr0 & 0x80) {
      if (v.envMode >= DECAY) {
        env--;
        env -= env >> 8;
        rate = envData & 0x1f;
        if (v.envMode === DECAY) rate = ((this.tAdsr0 >> 3) & 0x0e) + 0x10;
      } else {
        rate = (this.tAdsr0 & 0x0f) * 2 + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      envData = this.regs[v.reg + V_GAIN]!;
      const mode = envData >> 5;
      if (mode < 4) {
        env = envData * 0x10;
        rate = 31;
      } else {
        rate = envData & 0x1f;
        if (mode === 4) env -= 0x20;
        else if (mode < 6) {
          env--;
          env -= env >> 8;
        } else {
          env += 0x20;
          if (mode > 6 && v.hiddenEnv >>> 0 >= 0x600) env += 0x8 - 0x20;
        }
      }
    }
    if (env >> 8 === envData >> 5 && v.envMode === DECAY) v.envMode = SUSTAIN;
    v.hiddenEnv = env;
    if (env >>> 0 > 0x7ff) {
      env = env < 0 ? 0 : 0x7ff;
      if (v.envMode === ATTACK) v.envMode = DECAY;
    }
    if (!this.readCounter(rate)) v.env = env;
  }

  private decodeBrr(v: Voice): void {
    let nybbles = this.tBrrByte * 0x100 + this.ram[(v.brrAddr + v.brrOffset + 1) & 0xffff]!;
    const header = this.tBrrHeader;
    const b = v.buf;
    let pos = v.bufPos;
    v.bufPos += 4;
    if (v.bufPos >= BRR_BUF) v.bufPos = 0;
    const shift = header >> 4;
    const filter = header & 0x0c;
    for (const end = pos + 4; pos < end; pos++, nybbles <<= 4) {
      let s = s16(nybbles) >> 12;
      if (shift <= 12) s = (s << shift) >> 1;
      else s &= ~0x7ff;
      const p1 = b[pos + BRR_BUF - 1]!;
      const p2 = b[pos + BRR_BUF - 2]! >> 1;
      if (filter >= 8) {
        s += p1;
        s -= p2;
        if (filter === 8) {
          s += p2 >> 4;
          s += (p1 * -3) >> 6;
        } else {
          s += (p1 * -13) >> 7;
          s += (p2 * 3) >> 4;
        }
      } else if (filter) {
        s += p1 >> 1;
        s += -p1 >> 5;
      }
      s = s16(clamp16(s) * 2);
      b[pos + BRR_BUF] = s;
      b[pos] = s;
    }
  }

  // ---- misc clocks -------------------------------------------------------------------------

  private misc27(): void {
    this.tPmon = this.regs[R_PMON]! & 0xfe; // voice 0 has no PMON
  }

  private misc28(): void {
    this.tNon = this.regs[R_NON]!;
    this.tEon = this.regs[R_EON]!;
    this.tDir = this.regs[R_DIR]!;
  }

  private misc29(): void {
    this.everyOtherSample ^= 1;
    if (this.everyOtherSample) this.newKon &= ~this.kon; // clears KON 63 clocks after it was read
  }

  private misc30(): void {
    if (this.everyOtherSample) {
      this.kon = this.newKon;
      this.tKoff = this.regs[R_KOFF]!;
    }
    if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;
    if (!this.readCounter(this.regs[R_FLG]! & 0x1f)) {
      const feedback = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (feedback & 0x4000) ^ (this.noise >> 1);
    }
  }

  // ---- voice clocks ------------------------------------------------------------------------

  private v1(v: Voice): void {
    this.tDirAddr = (this.tDir * 0x100 + this.tSrcn * 4) & 0xffff;
    this.tSrcn = this.regs[v.reg + V_SRCN]!;
  }

  private v2(v: Voice): void {
    let entry = this.tDirAddr;
    if (!v.konDelay) entry += 2;
    this.tBrrNextAddr = this.ram[entry & 0xffff]! | (this.ram[(entry + 1) & 0xffff]! << 8);
    this.tAdsr0 = this.regs[v.reg + V_ADSR0]!;
    this.tPitch = this.regs[v.reg + V_PITCHL]!;
  }

  private v3a(v: Voice): void {
    this.tPitch += (this.regs[v.reg + V_PITCHH]! & 0x3f) << 8;
  }

  private v3b(v: Voice): void {
    this.tBrrByte = this.ram[(v.brrAddr + v.brrOffset) & 0xffff]!;
    this.tBrrHeader = this.ram[v.brrAddr]!;
  }

  private v3c(v: Voice): void {
    if (this.tPmon & v.vbit) this.tPitch += ((this.tOutput >> 5) * this.tPitch) >> 10;
    if (v.konDelay) {
      if (v.konDelay === 5) {
        v.brrAddr = this.tBrrNextAddr;
        v.brrOffset = 1;
        v.bufPos = 0;
        this.tBrrHeader = 0; // the header is ignored on this sample
        this.konCheck = 1;
      }
      v.env = 0;
      v.hiddenEnv = 0;
      v.interpPos = 0;
      if (--v.konDelay & 3) v.interpPos = 0x4000;
      this.tPitch = 0;
    }
    let output = this.interpolate(v);
    if (this.tNon & v.vbit) output = s16(this.noise * 2);
    this.tOutput = ((output * v.env) >> 11) & ~1;
    v.tEnvxOut = (v.env >> 4) & 0xff;
    if (this.regs[R_FLG]! & 0x80 || (this.tBrrHeader & 3) === 1) {
      v.envMode = RELEASE;
      v.env = 0;
    }
    if (this.everyOtherSample) {
      if (this.tKoff & v.vbit) v.envMode = RELEASE;
      if (this.kon & v.vbit) {
        v.konDelay = 5;
        v.envMode = ATTACK;
      }
    }
    if (!v.konDelay) this.runEnvelope(v);
  }

  private v3(v: Voice): void {
    this.v3a(v);
    this.v3b(v);
    this.v3c(v);
  }

  private v4(v: Voice): void {
    this.tLooped = 0;
    if (v.interpPos >= 0x4000) {
      this.decodeBrr(v);
      v.brrOffset += 2;
      if (v.brrOffset >= 9) {
        v.brrAddr = (v.brrAddr + 9) & 0xffff;
        if (this.tBrrHeader & 1) {
          v.brrAddr = this.tBrrNextAddr;
          this.tLooped = v.vbit;
        }
        v.brrOffset = 1;
      }
    }
    v.interpPos = (v.interpPos & 0x3fff) + this.tPitch;
    if (v.interpPos > 0x7fff) v.interpPos = 0x7fff;
    this.output(v, 0);
  }

  private output(v: Voice, ch: number): void {
    const amp = (this.tOutput * s8(this.regs[v.reg + V_VOLL + ch]!)) >> 7;
    if (ch === 0) {
      this.tMainOutL = clamp16(this.tMainOutL + amp);
      if (this.tEon & v.vbit) this.tEchoOutL = clamp16(this.tEchoOutL + amp);
    } else {
      this.tMainOutR = clamp16(this.tMainOutR + amp);
      if (this.tEon & v.vbit) this.tEchoOutR = clamp16(this.tEchoOutR + amp);
    }
  }

  private v5(v: Voice): void {
    this.output(v, 1);
    let endx = this.regs[R_ENDX]! | this.tLooped;
    if (v.konDelay === 5) endx &= ~v.vbit;
    this.endxBuf = endx & 0xff;
  }

  private v6(): void {
    this.outxBuf = (this.tOutput >> 8) & 0xff;
  }

  private v7(v: Voice): void {
    this.regs[R_ENDX] = this.endxBuf;
    this.xregs[R_ENDX] = this.endxBuf;
    this.envxBuf = v.tEnvxOut;
  }

  private v8(v: Voice): void {
    this.regs[v.reg + V_OUTX] = this.outxBuf;
    this.xregs[v.reg + V_OUTX] = this.outxBuf;
  }

  private v9(v: Voice): void {
    this.regs[v.reg + V_ENVX] = this.envxBuf;
    this.xregs[v.reg + V_ENVX] = this.envxBuf;
  }

  private v741(n: number): void {
    const vs = this.voices;
    this.v7(vs[n]!);
    this.v1(vs[n + 3]!);
    this.v4(vs[n + 1]!);
  }

  private v852(n: number): void {
    const vs = this.voices;
    this.v8(vs[n]!);
    this.v5(vs[n + 1]!);
    this.v2(vs[n + 2]!);
  }

  private v963(n: number): void {
    const vs = this.voices;
    this.v9(vs[n]!);
    this.v6();
    this.v3(vs[n + 2]!);
  }

  // ---- echo --------------------------------------------------------------------------------

  /** history sample i (0 = oldest) of channel ch */
  private fir(i: number, ch: number): number {
    return (this.echoHist[2 * (this.echoHistPos + i + 1) + ch]! * s8(this.regs[R_FIR + i * 0x10]!)) >> 6;
  }

  private echoRead(ch: number): void {
    const p = (this.tEchoPtr + ch * 2) & 0xffff;
    const s = s16(this.ram[p]! | (this.ram[(p + 1) & 0xffff]! << 8));
    this.echoHist[2 * this.echoHistPos + ch] = s >> 1;
    this.echoHist[2 * (this.echoHistPos + ECHO_HIST) + ch] = s >> 1;
  }

  private echo22(): void {
    if (++this.echoHistPos >= ECHO_HIST) this.echoHistPos = 0;
    this.tEchoPtr = (this.tEsa * 0x100 + this.echoOffset) & 0xffff;
    this.echoRead(0);
    this.tEchoInL = this.fir(0, 0);
    this.tEchoInR = this.fir(0, 1);
  }

  private echo23(): void {
    const l = this.fir(1, 0) + this.fir(2, 0);
    const r = this.fir(1, 1) + this.fir(2, 1);
    this.tEchoInL += l;
    this.tEchoInR += r;
    this.echoRead(1);
  }

  private echo24(): void {
    this.tEchoInL += this.fir(3, 0) + this.fir(4, 0) + this.fir(5, 0);
    this.tEchoInR += this.fir(3, 1) + this.fir(4, 1) + this.fir(5, 1);
  }

  private echo25(): void {
    let l = s16(this.tEchoInL + this.fir(6, 0));
    let r = s16(this.tEchoInR + this.fir(6, 1));
    l += s16(this.fir(7, 0));
    r += s16(this.fir(7, 1));
    this.tEchoInL = clamp16(l) & ~1;
    this.tEchoInR = clamp16(r) & ~1;
  }

  private echoOutput(ch: number): number {
    const main = ch ? this.tMainOutR : this.tMainOutL;
    const echo = ch ? this.tEchoInR : this.tEchoInL;
    return clamp16(s16((main * s8(this.regs[R_MVOLL + ch * 0x10]!)) >> 7) + s16((echo * s8(this.regs[R_EVOLL + ch * 0x10]!)) >> 7));
  }

  private echo26(): void {
    this.tMainOutL = this.echoOutput(0);
    const efb = s8(this.regs[R_EFB]!);
    const l = this.tEchoOutL + s16((this.tEchoInL * efb) >> 7);
    const r = this.tEchoOutR + s16((this.tEchoInR * efb) >> 7);
    this.tEchoOutL = clamp16(l) & ~1;
    this.tEchoOutR = clamp16(r) & ~1;
  }

  private echo27(): void {
    let l = this.tMainOutL;
    let r = this.echoOutput(1);
    this.tMainOutL = 0;
    this.tMainOutR = 0;
    if (this.regs[R_FLG]! & 0x40) {
      l = 0;
      r = 0;
    }
    const out = this.out;
    if (out !== null && this.outCount + 2 <= out.length) {
      out[this.outCount++] = l;
      out[this.outCount++] = r;
    }
  }

  private echo28(): void {
    this.tEchoEnabled = this.regs[R_FLG]!;
  }

  private echoWrite(ch: number): void {
    if (!(this.tEchoEnabled & 0x20)) {
      const p = (this.tEchoPtr + ch * 2) & 0xffff;
      const v = ch ? this.tEchoOutR : this.tEchoOutL;
      this.ram[p] = v;
      this.ram[(p + 1) & 0xffff] = v >> 8;
    }
    if (ch) this.tEchoOutR = 0;
    else this.tEchoOutL = 0;
  }

  private echo29(): void {
    this.tEsa = this.regs[R_ESA]!;
    if (!this.echoOffset) this.echoLength = (this.regs[R_EDL]! & 0x0f) * 0x800;
    this.echoOffset += 4;
    if (this.echoOffset >= this.echoLength) this.echoOffset = 0;
    this.echoWrite(0);
    this.tEchoEnabled = this.regs[R_FLG]!;
  }

  private echo30(): void {
    this.echoWrite(1);
  }

  // ---- the 32 clocks of a sample -----------------------------------------------------------

  private clockPhase(p: number): void {
    const vs = this.voices;
    switch (p) {
      case 0:
        this.v5(vs[0]!);
        this.v2(vs[1]!);
        break;
      case 1:
        this.v6();
        this.v3(vs[1]!);
        break;
      case 2:
        this.v741(0);
        break;
      case 3:
        this.v852(0);
        break;
      case 4:
        this.v963(0);
        break;
      case 5:
        this.v741(1);
        break;
      case 6:
        this.v852(1);
        break;
      case 7:
        this.v963(1);
        break;
      case 8:
        this.v741(2);
        break;
      case 9:
        this.v852(2);
        break;
      case 10:
        this.v963(2);
        break;
      case 11:
        this.v741(3);
        break;
      case 12:
        this.v852(3);
        break;
      case 13:
        this.v963(3);
        break;
      case 14:
        this.v741(4);
        break;
      case 15:
        this.v852(4);
        break;
      case 16:
        this.v963(4);
        break;
      case 17:
        this.v1(vs[0]!);
        this.v7(vs[5]!);
        this.v4(vs[6]!);
        break;
      case 18:
        this.v852(5);
        break;
      case 19:
        this.v963(5);
        break;
      case 20:
        this.v1(vs[1]!);
        this.v7(vs[6]!);
        this.v4(vs[7]!);
        break;
      case 21:
        this.v8(vs[6]!);
        this.v5(vs[7]!);
        this.v2(vs[0]!); // t_brr_next_addr order dependency
        break;
      case 22:
        this.v3a(vs[0]!);
        this.v9(vs[6]!);
        this.v6();
        this.echo22();
        break;
      case 23:
        this.v7(vs[7]!);
        this.echo23();
        break;
      case 24:
        this.v8(vs[7]!);
        this.echo24();
        break;
      case 25:
        this.v3b(vs[0]!);
        this.v9(vs[7]!);
        this.echo25();
        break;
      case 26:
        this.echo26();
        break;
      case 27:
        this.misc27();
        this.echo27();
        break;
      case 28:
        this.misc28();
        this.echo28();
        break;
      case 29:
        this.misc29();
        this.echo29();
        break;
      case 30:
        this.misc30();
        this.v3c(vs[0]!);
        this.echo30();
        break;
      default:
        this.v4(vs[0]!);
        this.v1(vs[2]!);
    }
  }

  /** Run n clocks. */
  run(n: number): void {
    let p = this.phase;
    for (let k = 0; k < n; k++) {
      this.clockPhase(p);
      p = (p + 1) & 31;
    }
    this.phase = p;
  }

  // ---- snapshots ---------------------------------------------------------------------------

  private scalars(): number[] {
    return [this.clock, this.echoHistPos, this.everyOtherSample, this.kon, this.noise, this.counter, this.echoOffset,
      this.echoLength, this.phase, this.konCheck, this.newKon, this.endxBuf, this.envxBuf, this.outxBuf, this.tPmon,
      this.tNon, this.tEon, this.tDir, this.tKoff, this.tBrrNextAddr, this.tAdsr0, this.tBrrHeader, this.tBrrByte,
      this.tSrcn, this.tEsa, this.tEchoEnabled, this.tDirAddr, this.tPitch, this.tOutput, this.tLooped, this.tEchoPtr,
      this.tMainOutL, this.tMainOutR, this.tEchoOutL, this.tEchoOutR, this.tEchoInL, this.tEchoInR];
  }

  save(s: Int32Array): void {
    for (let k = 0; k < 32; k++) s[k] = this.regs[4 * k]! | (this.regs[4 * k + 1]! << 8) | (this.regs[4 * k + 2]! << 16) | (this.regs[4 * k + 3]! << 24);
    for (let k = 0; k < 32; k++) s[32 + k] = this.xregs[4 * k]! | (this.xregs[4 * k + 1]! << 8) | (this.xregs[4 * k + 2]! << 16) | (this.xregs[4 * k + 3]! << 24);
    let o = 64;
    for (const v of this.voices) {
      s.set(v.buf, o);
      o += 2 * BRR_BUF;
      s[o++] = v.bufPos;
      s[o++] = v.interpPos;
      s[o++] = v.brrAddr;
      s[o++] = v.brrOffset;
      s[o++] = v.konDelay;
      s[o++] = v.envMode;
      s[o++] = v.env;
      s[o++] = v.hiddenEnv;
      s[o++] = v.tEnvxOut;
    }
    s.set(this.echoHist, o);
    o += this.echoHist.length;
    for (const x of this.scalars()) s[o++] = x;
  }

  load(s: Int32Array): void {
    for (let k = 0; k < 128; k++) {
      this.regs[k] = s[k >> 2]! >> (8 * (k & 3));
      this.xregs[k] = s[32 + (k >> 2)]! >> (8 * (k & 3));
    }
    let o = 64;
    for (const v of this.voices) {
      v.buf.set(s.subarray(o, o + 2 * BRR_BUF));
      o += 2 * BRR_BUF;
      v.bufPos = s[o++]!;
      v.interpPos = s[o++]!;
      v.brrAddr = s[o++]!;
      v.brrOffset = s[o++]!;
      v.konDelay = s[o++]!;
      v.envMode = s[o++]!;
      v.env = s[o++]!;
      v.hiddenEnv = s[o++]!;
      v.tEnvxOut = s[o++]!;
    }
    this.echoHist.set(s.subarray(o, o + this.echoHist.length));
    o += this.echoHist.length;
    const k = (): number => s[o++]!;
    this.clock = k();
    this.echoHistPos = k();
    this.everyOtherSample = k();
    this.kon = k();
    this.noise = k();
    this.counter = k();
    this.echoOffset = k();
    this.echoLength = k();
    this.phase = k();
    this.konCheck = k();
    this.newKon = k();
    this.endxBuf = k();
    this.envxBuf = k();
    this.outxBuf = k();
    this.tPmon = k();
    this.tNon = k();
    this.tEon = k();
    this.tDir = k();
    this.tKoff = k();
    this.tBrrNextAddr = k();
    this.tAdsr0 = k();
    this.tBrrHeader = k();
    this.tBrrByte = k();
    this.tSrcn = k();
    this.tEsa = k();
    this.tEchoEnabled = k();
    this.tDirAddr = k();
    this.tPitch = k();
    this.tOutput = k();
    this.tLooped = k();
    this.tEchoPtr = k();
    this.tMainOutL = k();
    this.tMainOutR = k();
    this.tEchoOutL = k();
    this.tEchoOutR = k();
    this.tEchoInL = k();
    this.tEchoInR = k();
  }

  /**
   * Load the DSP block of a snes9x savestate (SPC_DSP::copy_state); returns the bytes read.
   * The history comes back starting at the current position, as snes9x writes it.
   */
  loadSnes9x(b: Uint8Array, at: number): number {
    let o = at;
    const u8 = (): number => b[o++]!;
    const u16 = (): number => {
      const v = b[o]! | (b[o + 1]! << 8);
      o += 2;
      return v;
    };
    const i16 = (): number => s16(u16());
    const extra = (): void => {
      o += 1 + b[o]!;
    };
    this.regs.set(b.subarray(o, o + 128));
    o += 128;
    for (const v of this.voices) {
      for (let i = 0; i < BRR_BUF; i++) {
        const s = i16();
        v.buf[i] = s;
        v.buf[i + BRR_BUF] = s;
      }
      v.interpPos = u16();
      v.brrAddr = u16();
      v.env = u16();
      v.hiddenEnv = i16();
      v.bufPos = u8();
      v.brrOffset = u8();
      v.konDelay = u8();
      v.envMode = u8();
      v.tEnvxOut = u8();
      extra();
    }
    for (let i = 0; i < ECHO_HIST; i++) {
      for (let j = 0; j < 2; j++) {
        const s = i16();
        this.echoHist[2 * i + j] = s;
        this.echoHist[2 * (i + ECHO_HIST) + j] = s;
      }
    }
    this.echoHistPos = 0;
    this.everyOtherSample = u8();
    this.kon = u8();
    this.noise = u16();
    this.counter = u16();
    this.echoOffset = u16();
    this.echoLength = u16();
    this.phase = u8();
    this.newKon = u8();
    this.endxBuf = u8();
    this.envxBuf = u8();
    this.outxBuf = u8();
    this.tPmon = u8();
    this.tNon = u8();
    this.tEon = u8();
    this.tDir = u8();
    this.tKoff = u8();
    this.tBrrNextAddr = u16();
    this.tAdsr0 = u8();
    this.tBrrHeader = u8();
    this.tBrrByte = u8();
    this.tSrcn = u8();
    this.tEsa = u8();
    this.tEchoEnabled = u8();
    this.tMainOutL = i16();
    this.tMainOutR = i16();
    this.tEchoOutL = i16();
    this.tEchoOutR = i16();
    this.tEchoInL = i16();
    this.tEchoInR = i16();
    this.tDirAddr = u16();
    this.tPitch = u16();
    this.tOutput = i16();
    this.tEchoPtr = u16();
    this.tLooped = u8();
    this.xregs.set(b.subarray(o, o + 128));
    o += 128;
    extra();
    this.konCheck = 0;
    return o - at;
  }
}
