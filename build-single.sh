#!/usr/bin/env bash
set -euo pipefail
# Build the single-file ego-linux executable (harness embedded, no repo needed at runtime).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
echo "== build harness =="
if [ ! -d ego-lite ]; then echo "cloning upstream harness (citrolabs/ego-lite, MIT)…"; git clone --depth 1 https://github.com/citrolabs/ego-lite ego-lite; fi
(cd ego-lite/package/ego-browser && npm ci --ignore-scripts >/dev/null 2>&1 && npm run build >/dev/null 2>&1)
BUNDLE="ego-lite/package/ego-browser/dist/out/index.js"
SKILL="ego-lite/package/ego-browser/dist/out/ego-browser/SKILL.md"
test -f "$BUNDLE" || { echo "bundle missing: $BUNDLE"; exit 1; }
mkdir -p dist
python3 - "$ROOT" <<'PY'
import base64, pathlib, sys
root = pathlib.Path(sys.argv[1])
src = (root / "ego-linux.mjs").read_text()
bundle_b64 = base64.b64encode((root / "ego-lite/package/ego-browser/dist/out/index.js").read_bytes()).decode()
skill_path = root / "ego-lite/package/ego-browser/dist/out/ego-browser/SKILL.md"
skill_b64 = base64.b64encode(skill_path.read_bytes()).decode() if skill_path.exists() else ""
old = "let EMBEDDED_BUNDLE_B64 = null, EMBEDDED_SKILL_B64 = null; // injected by build-single.sh"
new = f"let EMBEDDED_BUNDLE_B64 = {bundle_b64!r}, EMBEDDED_SKILL_B64 = {skill_b64!r}; // injected by build-single.sh"
assert old in src, "embed marker not found"
out = src.replace(old, new)
dest = root / "dist/ego-linux"
dest.write_text(out)
dest.chmod(0o755)
print(f"wrote {dest} ({dest.stat().st_size/1024:.0f} KB)")
PY
ls -lh dist/ego-linux
echo "test:"; ./dist/ego-linux --version; ./dist/ego-linux --help | head -3
df -h "$ROOT" | tail -1
