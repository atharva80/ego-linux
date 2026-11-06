# ego-linux v4 — test report (2026-11-05, Ubuntu 24.04, GNOME, Chromium 154)

Single-file executable: `dist/ego-linux` (1.3 MB, harness embedded, verified
standalone with the repo hidden). Install: `./install.sh` ->
`~/.local/bin/ego-linux` + GNOME `.desktop` launcher (`ego-linux gui`).
Disk throughout: **25 GB free** at V5 end (floor 15 GB; project itself
is ~80 MB, the drop from 29 GB was system usage elsewhere).

## Suite: `tests/e2e.sh` — 15 pass, 0 fail (2026-11-05, V5 single-file build; dialog passed within retries)

| # | Scenario | Result |
|---|---|---|
| 1 | `--help` / `--version` / `skill` | PASS |
| 2 | goto + snapshot | PASS (`HelloTest`) |
| 3 | fill + click by quoted `loc=role:` | PASS (`ok:E2E`) |
| 4 | click by `@ref` | PASS (`after-ref`) |
| 5 | click inside iframe | PASS (`before → after`) |
| 6 | viewport vs full_page snapshot | PASS (BottomBtn only in FULL) |
| 7 | JS dialog `alert` + `acceptDialog()` | **FLAKY** — 2/3 standalone runs pass; 1/3 fails with harness `CdpRequestTimeoutError: Input.dispatchMouseEvent` (click racing the modal dialog it opens). Retried in suite (3 tries). This race is in the upstream harness, not Linux-specific. |
| 8 | keyboard press/type | PASS (`hello-keybd`) |
| 9 | screenshot | PASS (valid PNG) |
| 10 | multi-Space isolation (2 BrowserContexts) | PASS |
| 11 | daemon persistence (create run 1, reuse run 2) | PASS |
| 12 | `markTaskSpaceError` + `deleteSpaces` (RE-found native methods) | PASS |
| 13 | GUI API (`:8765` spaces/snapshot/screenshot, create Space via GUI) | PASS |
| 14 | real site `https://example.com/` | PASS (network-dependent, see flaky) |
| 15 | upstream harness `npm test` | **609/609 PASS** |
| 16 | headed mode under Xvfb | PASS (snapshot + screenshot) |
| 17 | single-file standalone (repo hidden, copied to `/tmp`) | PASS |
| 18 | Chrome profile import (fake profile, disk guard) | PASS |
| 19 | attach mode (`EGO_LINUX_CDP_URL` to running Chrome) | PASS, browser stays alive |

## V5 additions verified in this run
- `navigator.webdriver === undefined` in-page (anti-detect injection) ✅
- CSS stable locators (`loc=css:#myid`, `loc=css:#go`) fill+click ✅
- `showAgentGesture` (point/think/outcome) — no crash, overlay aria-hidden ✅

## Flaky (works, but timing/network sensitive)
- **Dialog click race** (#7 above): modal `alert` blocks the renderer
  mid-click; harness CDP input occasionally times out (15 s). Retry or
  `acceptDialog` first via a CDP listener. Not fixable in the shim —
  the shim forwards CDP verbatim, same as the native bridge.
- **Real sites**: DNS/network, site A/B, CAPTCHA/bot walls. Local
  `data:` fixtures are deterministic; live sites are not.
- **Daemon spawn race**: first run after `stop` can hit a profile lock
  if the old Chromium hasn't fully exited (~1 s). Retrying the run
  succeeds. Mitigated by daemon reuse (normal path never relaunches).
- **Headed/Xvfb + SwiftShader**: GPU rasterisation timing on weak
  machines; screenshots are slightly slower, content is correct.
- **Huge pages**: AX snapshot of 10k+ nodes is O(n) CDP calls for
  viewport filtering and can approach the 15 s CDP timeout. Native
  fork is faster (in-process snapshot).

## Impossible to fix without the closed Chromium fork source
- **`egoAutomated` CDP domain**: stock Chromium rejects it (harness
  tolerates). Sites *can* detect CDP (`navigator.webdriver`, console
  timing). `--disable-blink-features=AutomationControlled` helps but
  is not equivalent to the fork hiding console messages at the browser
  process level.
- **Native snapshot engine**: action-marks, stable-locator backfill,
  `SnapshotSubtree` feature flag, and deeply-nested-iframe handling
  are inside the fork. Our AX+DOM approximation passes all functional
  tests but is slower and less token-efficient on complex pages.
- **Cross-origin (OOPIF) iframe AX**: same-origin iframes work via
  `DOM.getDocument(pierce)`; cross-origin iframe *content* is
  invisible to snapshot (browser privilege boundary). The fork can
  see it; stock CDP cannot without a separate target attach, which
  Chromium only creates for some OOPIFs.
- **Native Spaces UI chrome / Omaha auto-update / default-browser
  registration**: replaced by the web GUI (`:8765`), headed Chromium,
  and manual `install.sh`. No pixel/parity claim.
- **Undocumented native internals** (`libaperitif`, Aperitif helpers):
  identified by RE (see `REVERSE-ENGINEERING.md`) but not portable.

## How to run the suite
```bash
./build-single.sh          # rebuild dist/ego-linux
./tests/e2e.sh             # full suite (needs network for #14, ~2 min)
./install.sh               # install to ~/.local/bin + GNOME launcher
ego-linux gui              # dashboard at http://127.0.0.1:8765/
```
