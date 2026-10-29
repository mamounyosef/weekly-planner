"""Replace a 1-based inclusive line range of a file with the contents of another file.

Usage: python tools/splice-lines.py <target> <first> <last> <replacement-file>
Keeps the target's line endings. Prints the lines it removed (first and last) so
a wrong range is obvious.
"""
import sys

target, first, last, repl = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
raw = open(target, "rb").read()
eol = b"\r\n" if b"\r\n" in raw else b"\n"
lines = raw.split(eol)
new = open(repl, "rb").read().replace(b"\r\n", b"\n").rstrip(b"\n").split(b"\n")
print("removing from:", lines[first - 1][:80].decode("utf-8", "replace"))
print("removing to:  ", lines[last - 1][:80].decode("utf-8", "replace"))
lines[first - 1:last] = new
open(target, "wb").write(eol.join(lines))
