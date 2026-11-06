# ego-linux — ego lite for Linux

The fastest browser for AI agents, ported to Linux (Ubuntu/GNOME). The
upstream [ego lite](https://github.com/citrolabs/ego-lite) ships only
macOS/Windows binaries; this project reimplements its closed native
bridge on stock Chromium CDP and runs the open-source harness
unmodified. See `REVERSE-ENGINEERING.md` for the binary analysis
(Chromium 156 fork, `egoAutomated` domain, Node daemon + GUI).

## Install (Ubuntu/GNOME)
```bash
sudo apt install chromium-browser   # or Google Chrome
./install.sh                        # builds dist/ego-linux, links ~/.local/bin, adds GNOME launcher
ego-linux --version
ego-linux gui                       # dashboard: http://127.0.0.1:8765/
```

## Use (agents)
```bash
ego-linux <<'JS'
const t = await taskSpace("demo"); const p = t.page("p1");
await p.goto("https://example.com/");
console.log(await p.snapshot());
JS
```
A persistent daemon (browser + Spaces) starts on first run and survives
between calls, like the Mac app. `ego-linux status` lists Spaces,
`ego-linux stop` stops it, `EGO_LINUX_NO_DAEMON=1` forces single-run.

Modes: `EGO_LINUX_CDP_URL` (attach to your logged-in Chrome),
`EGO_LINUX_HEADLESS=0` (headed, e.g. under Xvfb), `EGO_LINUX_PROFILE`,
`CHROME_PATH`. Migrate Chrome logins: `ego-linux import-chrome`.

## Test
```bash
./tests/e2e.sh    # 15 scenarios + upstream 609 tests (see TEST-REPORT.md)
```

## Layout
- `ego-linux.mjs` — the bridge shim (source); `dist/ego-linux` — single-file build
- `build-single.sh` — embeds the upstream harness into one executable
- `GOAL.md` — overnight plan + status log · `TEST-REPORT.md` — pass/flaky/impossible
- `REVERSE-ENGINEERING.md` + `RE/` — Binary Ninja / radare2 analysis evidence
