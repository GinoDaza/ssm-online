/**
 * 65816 opcode table: mnemonic and addressing mode of each of the 256 opcodes (WDC W65C816S).
 *
 * Modes: imp (implied / accumulator), immM (immediate, width M), immX (width X), imm8,
 * dp, dpx, dpy, ind (dp), indl [dp], indy (dp),Y, indly [dp],Y, indx (dp,X), abs, absx, absy,
 * long, longx, sr, sry (sr,S),Y, rel8, rel16, absind (abs), absindx (abs,X), absindl [abs],
 * blk (MVN / MVP: dst bank, src bank).
 */

export type Mode =
  | 'imp'
  | 'immM'
  | 'immX'
  | 'imm8'
  | 'dp'
  | 'dpx'
  | 'dpy'
  | 'ind'
  | 'indl'
  | 'indy'
  | 'indly'
  | 'indx'
  | 'abs'
  | 'absx'
  | 'absy'
  | 'long'
  | 'longx'
  | 'sr'
  | 'sry'
  | 'rel8'
  | 'rel16'
  | 'absind'
  | 'absindx'
  | 'absindl'
  | 'blk';

const ROWS = `
BRK imm8|ORA indx|COP imm8|ORA sr|TSB dp|ORA dp|ASL dp|ORA indl|PHP imp|ORA immM|ASL imp|PHD imp|TSB abs|ORA abs|ASL abs|ORA long
BPL rel8|ORA indy|ORA ind|ORA sry|TRB dp|ORA dpx|ASL dpx|ORA indly|CLC imp|ORA absy|INC imp|TCS imp|TRB abs|ORA absx|ASL absx|ORA longx
JSR abs|AND indx|JSL long|AND sr|BIT dp|AND dp|ROL dp|AND indl|PLP imp|AND immM|ROL imp|PLD imp|BIT abs|AND abs|ROL abs|AND long
BMI rel8|AND indy|AND ind|AND sry|BIT dpx|AND dpx|ROL dpx|AND indly|SEC imp|AND absy|DEC imp|TSC imp|BIT absx|AND absx|ROL absx|AND longx
RTI imp|EOR indx|WDM imm8|EOR sr|MVP blk|EOR dp|LSR dp|EOR indl|PHA imp|EOR immM|LSR imp|PHK imp|JMP abs|EOR abs|LSR abs|EOR long
BVC rel8|EOR indy|EOR ind|EOR sry|MVN blk|EOR dpx|LSR dpx|EOR indly|CLI imp|EOR absy|PHY imp|TCD imp|JML long|EOR absx|LSR absx|EOR longx
RTS imp|ADC indx|PER rel16|ADC sr|STZ dp|ADC dp|ROR dp|ADC indl|PLA imp|ADC immM|ROR imp|RTL imp|JMP absind|ADC abs|ROR abs|ADC long
BVS rel8|ADC indy|ADC ind|ADC sry|STZ dpx|ADC dpx|ROR dpx|ADC indly|SEI imp|ADC absy|PLY imp|TDC imp|JMP absindx|ADC absx|ROR absx|ADC longx
BRA rel8|STA indx|BRL rel16|STA sr|STY dp|STA dp|STX dp|STA indl|DEY imp|BIT immM|TXA imp|PHB imp|STY abs|STA abs|STX abs|STA long
BCC rel8|STA indy|STA ind|STA sry|STY dpx|STA dpx|STX dpy|STA indly|TYA imp|STA absy|TXS imp|TXY imp|STZ abs|STA absx|STZ absx|STA longx
LDY immX|LDA indx|LDX immX|LDA sr|LDY dp|LDA dp|LDX dp|LDA indl|TAY imp|LDA immM|TAX imp|PLB imp|LDY abs|LDA abs|LDX abs|LDA long
BCS rel8|LDA indy|LDA ind|LDA sry|LDY dpx|LDA dpx|LDX dpy|LDA indly|CLV imp|LDA absy|TSX imp|TYX imp|LDY absx|LDA absx|LDX absy|LDA longx
CPY immX|CMP indx|REP imm8|CMP sr|CPY dp|CMP dp|DEC dp|CMP indl|INY imp|CMP immM|DEX imp|WAI imp|CPY abs|CMP abs|DEC abs|CMP long
BNE rel8|CMP indy|CMP ind|CMP sry|PEI dp|CMP dpx|DEC dpx|CMP indly|CLD imp|CMP absy|PHX imp|STP imp|JML absindl|CMP absx|DEC absx|CMP longx
CPX immX|SBC indx|SEP imm8|SBC sr|CPX dp|SBC dp|INC dp|SBC indl|INX imp|SBC immM|NOP imp|XBA imp|CPX abs|SBC abs|INC abs|SBC long
BEQ rel8|SBC indy|SBC ind|SBC sry|PEA abs|SBC dpx|INC dpx|SBC indly|SED imp|SBC absy|PLX imp|XCE imp|JSR absindx|SBC absx|INC absx|SBC longx
`;

export interface OpInfo {
  mn: string;
  mode: Mode;
}

export const OPCODES: readonly OpInfo[] = ROWS.trim()
  .split('\n')
  .flatMap((row) => row.split('|'))
  .map((cell) => {
    const [mn, mode] = cell.split(' ') as [string, Mode];
    return { mn, mode };
  });

if (OPCODES.length !== 256) throw new Error(`opcode table has ${OPCODES.length} rows`);

/** Operand bytes after the opcode, given the M / X widths (true = 8-bit). */
export function operandSize(mode: Mode, m8: boolean, x8: boolean): number {
  switch (mode) {
    case 'imp':
      return 0;
    case 'immM':
      return m8 ? 1 : 2;
    case 'immX':
      return x8 ? 1 : 2;
    case 'imm8':
    case 'dp':
    case 'dpx':
    case 'dpy':
    case 'ind':
    case 'indl':
    case 'indy':
    case 'indly':
    case 'indx':
    case 'sr':
    case 'sry':
    case 'rel8':
      return 1;
    case 'abs':
    case 'absx':
    case 'absy':
    case 'rel16':
    case 'absind':
    case 'absindx':
    case 'absindl':
    case 'blk':
      return 2;
    case 'long':
    case 'longx':
      return 3;
  }
}

/** Mnemonics whose data width follows X (else M, for those with a data width). */
export const X_WIDTH = new Set(['LDX', 'LDY', 'STX', 'STY', 'CPX', 'CPY']);
