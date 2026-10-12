#!/usr/bin/env python3
"""Split a .metallib into per-function AIR bitcode files that LLVM can read.

Each function in a metallib is an LLVM bitcode *wrapper* (magic 0x0B17C0DE,
then version, offset, size, cputype). Carving from the raw 'BC\\xC0\\xDE' magic
gives "Invalid encoding" errors; keeping the 20-byte wrapper header works with
a stock LLVM (tested with Homebrew LLVM 20):

    python3 tools/metallib_split.py assets/apple/original/Resources/default.metallib /tmp/sh
    /opt/homebrew/opt/llvm/bin/llvm-dis /tmp/sh/shadowFragment.bc -o -

scripts/extract-apple-assets.sh runs this (when python3 and llvm-dis are
available) and writes the disassembly of the five shaders of this extension to
assets/apple/shaders/. It is Apple's code, so it is gitignored like the rest.
"""
import os
import re
import struct
import sys

src, out = sys.argv[1], sys.argv[2]
data = open(src, 'rb').read()
os.makedirs(out, exist_ok=True)
for m in re.finditer(b'\xde\xc0\x17\x0b', data):
    o = m.start()
    _magic, _ver, off, size, _cpu = struct.unpack('<5I', data[o:o + 20])
    blob = data[o:o + off + size]
    # the entry point names are camelCase <thing>Vertex / <thing>Fragment
    names = re.findall(rb'(?<![A-Za-z_])([a-z][a-z]*(?:Vertex|Fragment))', blob)
    names = names or re.findall(rb'([a-z]+(?:Vertex|Fragment))(?![A-Za-z])', blob)
    name = names[-1].decode() if names else f'fn_{o:x}'
    with open(os.path.join(out, f'{name}.bc'), 'wb') as f:
        f.write(blob)
    print(f'{o:#x} {size:6d} bytes -> {name}.bc')
