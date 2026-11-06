import binaryninja, sys, time
path, out = sys.argv[1], sys.argv[2]
t0=time.time()
bv = binaryninja.load(path)
with open(out, "w") as f:
    f.write(f"file: {path}\narch: {bv.arch.name} platform: {bv.platform.name}\nload_time_s: {time.time()-t0:.1f}\nfunctions: {len(bv.functions)}\n")
    f.write("\n== symbols (ego/main) ==\n")
    for fn in bv.functions:
        s = fn.symbol.name if fn.symbol else "?"
        if "ego" in s.lower() or s in ("main", "_main"):
            f.write(f"{hex(fn.start)} {s}\n")
    f.write("\n== strings (egoAutomated/SnapshotSubtree/showAgentGesture/taskSpace) ==\n")
    for s in bv.get_strings():
        v = s.value
        if isinstance(v, bytes): v = v.decode(errors="ignore")
        if any(k in v for k in ("egoAutomated", "SnapshotSubtree", "showAgentGesture", "markTaskSpaceError", "deleteSpaces", "taskSpace")):
            f.write(f"{hex(s.start)} {v[:120]!r}\n")
    f.write("\n== HLIL of parse_invocation / main (first 3 ego funcs) ==\n")
    n=0
    for fn in bv.functions:
        s = fn.symbol.name if fn.symbol else ""
        if "ego_cli" in s and n < 3:
            n+=1
            f.write(f"\n--- {s} @ {hex(fn.start)} ---\n")
            try:
                hlil = fn.hlil
                f.write(str(hlil)[:8000] + "\n")
            except Exception as e:
                f.write(f"hlil error: {e}\n")
    f.write(f"\ndone in {time.time()-t0:.1f}s\n")
print(f"wrote {out} in {time.time()-t0:.1f}s, funcs={len(bv.functions)}")
