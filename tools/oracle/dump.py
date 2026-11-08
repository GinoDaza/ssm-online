"""Fidelity fixtures: the original game's low WRAM, frame by frame, from the emulator.

Uses the emulator harness of the sibling disassembly repo (SSM_DISASM, default ../ssm-disasm:
tools/snescore/libretro.py and its plain snes9x core). Output stays local (fixtures/ is
git-ignored): it is game state, not something to publish.

  python3 tools/oracle/dump.py --input match1 --start 2830 --frames 600 --out fixtures/match1-2830
  python3 tools/oracle/dump.py --input R-vs2-1 --start 3000 --frames 300 --out fixtures/vs2-3000

Writes <out>.wram (frames + 1 records of 0x2000 bytes: the state before frame `start`, then the
state after each played frame) and <out>.json (meta: input script, start, frames, and the pad
buttons of each played frame as the script names them, pads 1-5).
"""
import argparse
import json
import os
import sys

DISASM = os.path.abspath(os.environ.get('SSM_DISASM', os.path.join(os.path.dirname(__file__), '..', '..', '..', 'ssm-disasm')))
sys.path.insert(0, os.path.join(DISASM, 'tools'))
from snescore.libretro import Emu, expand, read_script  # noqa: E402

WRAM_LOW = 0x2000


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--input', required=True, help='input script name in ssm-disasm/inputs (no .txt) or a path')
    ap.add_argument('--start', type=int, required=True, help='first frame to record')
    ap.add_argument('--frames', type=int, required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--full', action='store_true', help='all 128 KiB of WRAM per record (default: low 8 KiB)')
    a = ap.parse_args()
    size = 0x20000 if a.full else WRAM_LOW

    path = a.input if os.path.exists(a.input) else os.path.join(DISASM, 'inputs', a.input + '.txt')
    script = read_script(path)
    frames = expand(script)
    if a.start + a.frames > len(frames):
        sys.exit(f'{path}: {len(frames)} frames, asked for {a.start + a.frames}')
    rom = os.path.join(DISASM, 'roms', 'Saturday Night Slam Masters (USA).sfc')
    emu = Emu(rom, core=os.path.join(DISASM, 'tools', 'bin', 'snes9x_libretro.so'))
    if 'multitap' in script:
        sys.exit('multitap scripts: not supported by the dump yet')
    emu.play_frames(frames[:a.start])

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out + '.wram', 'wb') as f:
        f.write(emu.memory()[:size])
        for k in range(a.start, a.start + a.frames):
            emu.play(frames[k] + '*1')
            f.write(emu.memory()[:size])
    meta = dict(input=os.path.relpath(path, DISASM), start=a.start, frames=a.frames,
                record=size, core='snes9x_libretro (plain)', pads=frames[a.start:a.start + a.frames])
    json.dump(meta, open(a.out + '.json', 'w'), indent=0)
    print(f'{a.out}.wram: {a.frames + 1} x {size:#x} bytes from {meta["input"]} frame {a.start}')


if __name__ == '__main__':
    main()
