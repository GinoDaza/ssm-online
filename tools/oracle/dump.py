"""Fidelity fixtures: the original game's low WRAM, frame by frame, from the emulator.

Uses the emulator harness of the sibling disassembly repo (SSM_DISASM, default ../ssm-disasm:
tools/snescore/libretro.py and its plain snes9x core). Output stays local (fixtures/ is
git-ignored): it is game state, not something to publish.

  python3 tools/oracle/dump.py --input match1 --start 2830 --frames 600 --out fixtures/match1-2830
  python3 tools/oracle/dump.py --input R-vs2-1 --start 3000 --frames 300 --out fixtures/vs2-3000
  python3 tools/oracle/dump.py --core trace --input match1 --start 2830 --frames 600 --full --out fixtures/match1-2830-trace

<out>.apu is the sound unit's state at record 0: the SND block of the emulator's savestate
(snes9x S9xAPUSaveState: SMP RAM and registers, DSP, APU clocks).

--video also writes <out>.ppu, the PPU state of record 0 (VRAM 64 KiB, CGRAM 512 bytes, OAM 544
bytes, registers $2100-$21FF; the latched values are in the JSON as `ppu`), and <out>.video: the emulator's picture of each played frame, 256 x 224 RGB565
pixels (little-endian), frames 1..N. --audio writes <out>.audio: the emulator's sound output while
the frames play, 32040 Hz stereo s16le (the DSP's samples through snes9x's resampler at ratio
1, which only delays them).

--core trace uses the trace core (snes9x 1bcc369, built by ssm-disasm's tools/tracecore/build.sh)
instead of the libretro buildbot core: the translated game follows its timing to the clock.

Writes <out>.wram (frames + 1 records of 0x2000 bytes: the state before frame `start`, then the
state after each played frame) and <out>.json (meta: input script, start, frames, the pad
buttons of each played frame as the script names them, pads 1-5, and `cpu`: the CPU, timing
and DMA state of each record, read from the emulator's savestate). A record falls where the
emulator's frame ends: the first instruction boundary at or after scanline 225, often inside
the video IRQ, so seeding the translated game from a record needs that CPU state.
"""
import argparse
import json
import os
import struct
import sys

DISASM = os.path.abspath(os.environ.get('SSM_DISASM', os.path.join(os.path.dirname(__file__), '..', '..', '..', 'ssm-disasm')))
sys.path.insert(0, os.path.join(DISASM, 'tools'))
from snescore.libretro import Emu, expand, read_script  # noqa: E402
from snescore.savestate import blocks  # noqa: E402

WRAM_LOW = 0x2000
CORES = {'plain': ('snes9x_libretro.so', 'snes9x_libretro (plain)'),
         'trace': ('snes9x_trace_libretro.so', 'snes9x_trace_libretro (trace core, 1bcc369)')}


def cpu_state(emu):
    """CPU registers, scanline timing and DMA registers of the emulator now (snes9x savestate
    blocks CPU, REG, TIM, PPU, DMA, FIL; field layout of snes9x snapshot.cpp)."""
    b = blocks(emu.state())
    cpu, reg, tim, ppu, dma, fil = b['CPU'], b['REG'], b['TIM'], b['PPU'], b['DMA'], b['FIL']
    cycles, _, v = struct.unpack('>iii', cpu[:12])
    which, next_event = cpu[37], struct.unpack('>i', cpu[38:42])[0]
    pb, db, p, a, d, s, x, y, pc = struct.unpack('>BBHHHHHHH', reg)
    h_max = struct.unpack('>i', tim[4:8])[0]
    refresh = struct.unpack('>i', tim[36:40])[0]
    flag_change = struct.unpack('>i', tim[53:57])[0]
    channels = []
    for ch in range(8):
        r = dma[19 * ch:19 * (ch + 1)]
        ctrl = r[0] << 7 | r[1] << 6 | r[2] << 5 | r[3] << 3 | r[4] << 4 | r[5]
        a_addr, = struct.unpack('>H', r[7:9])
        count, = struct.unpack('>H', r[10:12])
        addr, = struct.unpack('>H', r[13:15])
        channels.append([ctrl, r[6], a_addr & 0xff, a_addr >> 8, r[9], count & 0xff, count >> 8, r[12],
                         addr & 0xff, addr >> 8, r[16], r[15] | r[18] << 1])
    return dict(pb=pb, db=db, p=p & 0xff, e=p >> 8 & 1, a=a, d=d, s=s, x=x, y=y, pc=pc,
                h=cycles, v=v, hMax=h_max, event=which, nextEvent=next_event, refresh=refresh,
                waiting=cpu[42], irqLine=cpu[44], nextIrq=struct.unpack('>i', tim[66:70])[0],
                flagChange=flag_change, field=fil[0x213f] >> 7, wram=struct.unpack('>I', ppu[10:14])[0],
                io=fil[0x4200:0x4220].hex(), dma=channels)


def ppu_state(emu):
    """PPU memories and registers now: (bytes for <out>.ppu, dict of latched values). Latched
    values are read from the end of snes9x's PPU snapshot block (snapshot.cpp SnapPPU)."""
    b = blocks(emu.state())
    p, fil = b['PPU'], b['FIL']
    end = len(p)
    if struct.unpack('>H', p[end - 11:end - 9])[0] not in (224, 239):
        sys.exit('unexpected snes9x PPU snapshot layout')
    cgram = b''.join(struct.pack('<H', v) for v in struct.unpack('>256H', p[64:64 + 512]))
    blob = b['VRA'] + cgram + p[2003:2003 + 544] + fil[0x2100:0x2200]
    offs = [struct.unpack('>HH', p[14 + 11 * n + 2:14 + 11 * n + 6]) for n in range(4)]
    matrix = struct.unpack('>HH', p[end - 79:end - 75])
    return blob, dict(hofs=[h for h, _ in offs], vofs=[v for _, v in offs], ofsLatch=p[end - 8],
                      m7a=matrix[0], m7b=matrix[1], m7Latch=p[end - 7],
                      fixed=[p[end - 15], p[end - 14], p[end - 13]], brightness=p[end - 12])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--input', required=True, help='input script name in ssm-disasm/inputs (no .txt) or a path')
    ap.add_argument('--start', type=int, required=True, help='first frame to record')
    ap.add_argument('--frames', type=int, required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--full', action='store_true', help='all 128 KiB of WRAM per record (default: low 8 KiB)')
    ap.add_argument('--core', choices=CORES, default='plain', help='emulator core (default: plain)')
    ap.add_argument('--video', action='store_true', help='also write the picture of each frame (<out>.video)')
    ap.add_argument('--audio', action='store_true', help='also write the sound of the played frames (<out>.audio)')
    a = ap.parse_args()
    size = 0x20000 if a.full else WRAM_LOW

    path = a.input if os.path.exists(a.input) else os.path.join(DISASM, 'inputs', a.input + '.txt')
    script = read_script(path)
    frames = expand(script)
    if a.start + a.frames > len(frames):
        sys.exit(f'{path}: {len(frames)} frames, asked for {a.start + a.frames}')
    rom = os.path.join(DISASM, 'roms', 'Saturday Night Slam Masters (USA).sfc')
    core_file, core_name = CORES[a.core]
    emu = Emu(rom, core=os.path.join(DISASM, 'tools', 'bin', core_file))
    if 'multitap' in script:
        sys.exit('multitap scripts: not supported by the dump yet')
    emu.play_frames(frames[:a.start])

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    cpu = [cpu_state(emu)]
    open(a.out + '.apu', 'wb').write(blocks(emu.state())['SND'])
    video = None
    if a.video:
        blob, cpu[0]['ppu'] = ppu_state(emu)
        open(a.out + '.ppu', 'wb').write(blob)
        video = open(a.out + '.video', 'wb')
    if a.audio:
        emu.audio = bytearray()
    with open(a.out + '.wram', 'wb') as f:
        f.write(emu.memory()[:size])
        for k in range(a.start, a.start + a.frames):
            emu.play(frames[k] + '*1')
            f.write(emu.memory()[:size])
            cpu.append(cpu_state(emu))
            if video:
                data, w, h, pitch = emu.frame
                if (emu.pixfmt, w, h) != (2, 256, 224):
                    sys.exit(f'frame {k}: {w}x{h} pixel format {emu.pixfmt}, expected 256x224 RGB565')
                video.write(b''.join(data[y * pitch:y * pitch + 2 * w] for y in range(h)))
    if video:
        video.close()
    if a.audio:
        open(a.out + '.audio', 'wb').write(bytes(emu.audio))
    meta = dict(input=os.path.relpath(path, DISASM), start=a.start, frames=a.frames,
                record=size, core=core_name, pads=frames[a.start:a.start + a.frames],
                cpu=cpu)
    json.dump(meta, open(a.out + '.json', 'w'), indent=0)
    print(f'{a.out}.wram: {a.frames + 1} x {size:#x} bytes from {meta["input"]} frame {a.start}')


if __name__ == '__main__':
    main()
