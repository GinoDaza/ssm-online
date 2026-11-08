"""Natural-call fixtures: real calls of an original routine, with the WRAM it started from and
the stores it made, for the TS port to replay.

A wrapper module for ssm-disasm's natcall.py: it loads the ssm-disasm model module named by
CAPTURE_MODULE, runs its verified models unchanged (so natcall still checks every call against
the trace core), and records a sample of the calls. Run through tools/oracle/capture.sh.

Record (little-endian): u16 D, u8 DB, u16 A, u16 X, u16 Y, u16 P, 5 pad bytes (16 bytes),
0x2000 bytes of low WRAM at the call, u16 n, then n x (u32 WRAM offset, u8 byte) = the stores
in order (natcall compares exactly these with the trace).
"""
import copy
import importlib
import os
import struct

SOURCE = importlib.import_module(os.environ['CAPTURE_MODULE'])
OUT = os.environ['CAPTURE_OUT']
MAX = int(os.environ.get('CAPTURE_MAX', '3000'))
STRIDE = int(os.environ.get('CAPTURE_STRIDE', '1'))
SCENARIO = os.environ.get('CAPTURE_TAG', 'x')

CONTROL_SCENARIOS = getattr(SOURCE, 'CONTROL_SCENARIOS', {})
_files, _seen, _kept = {}, {}, {}


def _ram(mem):
    head = mem[:0x2000]
    return head.tobytes() if hasattr(head, 'tobytes') else bytes(head)


def wrap(r):
    inner = r.model

    def model(c):
        n0 = len(c.out)
        regs = (c.D & 0xFFFF, c.DB & 0xFF, c.A & 0xFFFF, c.X & 0xFFFF, c.Y & 0xFFFF, c.P & 0xFFFF)
        ram = _ram(c.mem)
        try:
            return inner(c)
        finally:
            i = _seen.get(r.name, 0)
            _seen[r.name] = i + 1
            if i % STRIDE == 0 and _kept.get(r.name, 0) < MAX:
                _kept[r.name] = _kept.get(r.name, 0) + 1
                stores = [(o[1], o[2]) for o in c.out[n0:] if o[0] == 'w']
                f = _files.get(r.name)
                if f is None:
                    os.makedirs(OUT, exist_ok=True)
                    f = _files[r.name] = open(os.path.join(OUT, f'{r.name}-{os.getpid()}.calls'), 'ab')
                f.write(struct.pack('<HBHHHH5x', *regs) + ram + struct.pack('<H', len(stores)))
                f.write(b''.join(struct.pack('<IB', o, v) for o, v in stores))
                f.flush()

    w = copy.copy(r)
    w.model = model
    return w


ROUTINES = [wrap(r) for r in SOURCE.ROUTINES]
