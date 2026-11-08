#!/usr/bin/env bash
# Capture real calls of an original routine (through an ssm-disasm model module) into fixtures/calls/<module>/.
#   tools/oracle/capture.sh <module> [scenario ...]      e.g. rom_c1_motion match1 F40-1
# Env: CAPTURE_MAX (calls kept per routine per replay, 3000), CAPTURE_STRIDE (keep 1 in N, 1).
# Needs the trace core of ssm-disasm (tools/bin/snes9x_trace_libretro.so). natcall must PASS:
# the captured stores are then the original's own.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
disasm="$(cd "${SSM_DISASM:-$root/../ssm-disasm}" && pwd)"
module="$1"; shift
out="$root/fixtures/calls/$module"
mkdir -p "$out"; find "$out" -maxdepth 1 -name "*.calls" -delete
cd "$disasm"
CAPTURE_MODULE="$module" CAPTURE_OUT="$out" PYTHONPATH="$here:$disasm/tools/ssm:$disasm/tools" \
  python3 tools/ssm/natcall.py --module natcall_capture --out "$root/cache/natcall-$module" -j "${JOBS:-3}" \
  ${1:+--scenario "$@"}
ls -la "$out"
