#!/usr/bin/env bash
set -euo pipefail
# ego-linux v4 installer for Ubuntu/GNOME (user install, no sudo needed for the app itself).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "== disk guard (floor 15G) =="; df -h "$ROOT"
FREE_GB=$(df --output=avail -BG "$ROOT" | tail -1 | tr -dc '0-9')
[ "$FREE_GB" -ge 16 ] || { echo "Refusing: only ${FREE_GB}G free"; exit 1; }
echo "== dependencies =="
command -v node >/dev/null || { echo "Node >=22 required: https://nodejs.org (nvm install 22)"; exit 1; }
node --version
if ! command -v chromium >/dev/null && ! command -v google-chrome >/dev/null && ! command -v google-chrome-stable >/dev/null; then
  echo "Chromium not found. Install:"
  echo "  sudo apt update && sudo apt install chromium-browser"
  echo "or Google Chrome from https://www.google.com/chrome/"
  exit 1
fi
echo "== build single-file executable =="
"$ROOT/build-single.sh"
echo "== install =="
mkdir -p ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/scalable/apps
cp "$ROOT/dist/ego-linux" ~/.local/bin/ego-linux
chmod +x ~/.local/bin/ego-linux
cp "$ROOT/ego-linux.desktop" ~/.local/share/applications/
cp "$ROOT/ego-linux.svg" ~/.local/share/icons/hicolor/scalable/apps/ego-linux.svg
update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
echo "== smoke test =="
printf '%s\n' 'const t = await taskSpace("install-test"); const p = t.page("p1"); await p.goto("data:text/html,<title>OK</title><h1>Installed</h1>"); console.log(await p.snapshot()); await t.finish({keep: []});' | timeout 60 ego-linux
echo "Done. GUI: ego-linux gui  ·  Version: ego-linux --version"
df -h "$ROOT" | tail -1
