# GOAL: ego lite for Linux (`ego-linux`)

## Objective
Create a working Linux version of ego lite by reusing the open-source repo
`citrolabs/ego-lite` (MIT) and reverse-engineering/reimplementing only the
closed-source part: the native browser bridge `globalThis.ego`.

The repo does **not** contain the browser. It contains:
- `package/ego-browser/` — Node/CDP harness + agent skill (open source, buildable)
- `docs/native-bindings-api.md` — full spec of `globalThis.ego` (the bridge)
- `docs/local-runtime-development.md` — how the app embeds the harness

So the strategy is **not** to port/reverse the Chromium-fork binary. It is
to reimplement the documented bridge on top of stock Linux Chromium's CDP
(automation that already speaks CDP), then run the harness unmodified.

## Hard constraints
1. **Disk: NEVER let free space on this machine drop below 15 GB.**
   - Check `df -h /home/atharva/egolite_build` before/after every build, install, download.
   - Current baseline (2026-11-05): ~30 GB free of 292 GB, 90% used.
   - No duplicate clones (single copy at `egolite_build/ego-lite/`), no Docker images,
     no full Chromium source checkout, reuse system `chromium`/`google-chrome` + Playwright's.
   - Clean `/tmp`, browser profiles, and `node_modules` caches if free space trends down.
   - Abort any step that would breach 15 GB and report it instead.
2. Reuse the real repo as source of truth — do not fork the harness unless a
   Linux-only fix is unavoidable, and then keep it minimal and documented.
3. No secrets, no committing anything unless explicitly asked.

## Architecture (reverse-engineered from the repo)
```
agent script (stdin JS)
  -> ego-browser harness (package/ego-browser/dist/out/index.js, UNMODIFIED)
     -> globalThis.ego bridge  (REIMPLEMENTED for Linux in ego-linux.mjs)
        -> Chromium CDP over WebSocket (Target / Accessibility / DOM / Page …)
           -> system chromium (--remote-debugging-port, persistent profile)
```
Bridge API to implement (from `docs/native-bindings-api.md`):
`sendCDPMessage/onCDPMessage/onSendCDPMessageError`, `useTaskSpace`,
`createTaskSpace/listTaskSpaces/claimTaskSpace/closeTaskSpace/completeTaskSpace`,
`handOffTaskSpace/takeOverTaskSpace/setAgentTaskState`,
`createTab/listTabs`, `snapshot`, `listProfiles`, `getBrowserVersion`,
`animationHighlightMouseToPosition`.

Mapping:
- Task Space  -> Chromium `BrowserContext` (`Target.createBrowserContext`)
- Tab         -> `Target.createTarget` in that context, filtered by `browserContextId`
- Raw CDP     -> forwarded verbatim to the browser WebSocket; harness ids pass through
- Snapshot    -> `Accessibility.getFullAXTree` on the attached session;
  emit `{content, refs:[{backendNodeId, role, name, loc?}]}` in the harness's
  `root` + 2-space-indent + `[ref=N, loc=role:…]` format, so the existing
  element-resolver (`DOM.getBoxModel` / `DOM.resolveNode` by `backendNodeId`)
  works unchanged. This is the main quality gap vs. the closed fork's
  custom snapshot (no native action-marks / subtree flag / stable-locator
  backfill yet) — close it iteratively.
- Profiles    -> single `Default` profile for the PoC (real Chrome profile import
  via `--user-data-dir` persistence is the intended path).
- User-control/handoff -> in-POC stub flags that return the documented
  `EGO_TASK_SPACE_USER_IN_CONTROL` error shapes.

## Phases
- [x] P0 Recon: cloned repo, read AGENTS.md / native-bindings-api.md / browser-runtime.ts
- [x] P1 Proto shim (`ego-linux.mjs`): launch Chromium, CDP proxy, tasks/tabs,
      AX-tree snapshot; first `taskSpace -> goto -> snapshot` run on a local page
- [x] P2 Core workflows: click/fill/type by `@ref` and `loc=`, wait, screenshot,
      multi-tab, multi-space isolation
- [x] P3 Hardening: viewport-only snapshot, nested iframes/OOPIF sessions,
      JS dialogs, downloads/file-chooser, profile persistence + Chrome import,
      headed mode under Xvfb, keep-alive browser across script runs
- [x] P4 Packaging: `ego-linux` CLI wrapper, README, install/upgrade notes

## Extensive checks after proto (added 2026-11-05, user request)
After the first proto works, do NOT stop at "it launched". Run:
1. Harness's own test suite: `npm test` in `package/ego-browser` (build + typecheck + node --test)
2. Real-browser E2E cases adapted to the shim (goto, snapshot, click, fill, keyboard,
   navigation, dialog, screenshot, task-space isolation) against local fixtures,
   not live sites first
3. Snapshot fidelity checks: refs resolve via `DOM.getBoxModel`, `loc=` locators
   validate, subtree/viewport options, iframe content visibility
4. Concurrency: two task spaces in parallel, tab isolation, session re-attach
5. Failure modes: no task selected, user-control errors, CDP timeouts, Chromium crash/restart
6. Disk guard re-check after every test batch; clean profiles/caches as needed
7. Record all results + known gaps back into this file before calling the proto done.

## Overnight working agreement
- Work in small, verified steps; update this file as each phase lands.
- Prefer the smallest shim change that makes an upstream test pass.
- If blocked (e.g. a native-only Chromium feature has no CDP equivalent),
  document the gap, ship the best approximation, and move on — don't stall.
- Report free-disk numbers with every status update.

## Status log
- 2026-11-05: GOAL.md created. Baseline disk: 30 GB free. Repo cloned to
  `egolite_build/ego-lite/` (8.8 MB), harness builds clean
  (`dist/out/index.js`, 874 KB). First proto attempt hit Chromium sandbox
  (`--no-sandbox` needed on Ubuntu 23.10+ AppArmor) — fixing next.
- 2026-11-05 (proto): `ego-linux.mjs` works. Fixes landed:
  `--no-sandbox`, stdin via `readFileSync(0)`, auto-create a default tab in
  `createTaskSpace`, snapshot walk must descend into `ignored` AX containers
  and detect roots via `childIds` (AX nodes have no `parentId`).
  Verified: `taskSpace -> goto(data:) -> snapshot` shows heading/button refs;
  `fill(loc=role:textbox) + click(loc=role:button)` -> `clicked:Alice` in
  snapshot; screenshot PNG written; two Spaces isolated (BrowserContexts);
  real site `https://example.com/` snapshot correct. Disk: 29 GB free.
- 2026-11-05 (extensive checks, per user request):
  - Upstream harness `npm test`: **609/609 pass** (build + typecheck + node --test).
  - Fill/click/screenshot, multi-Space isolation, real-site navigation all pass.
  - Disk after checks: 29 GB free (still >> 15 GB floor).
  Known gaps (next hardening phase): viewport-only snapshot not yet filtered
  (AX tree is full-page; harness appends its own "more content" note),
  subtree snapshot is approximate, no native action-marks, single profile,
  no Chrome-login import UI yet, headed mode needs Xvfb/DISPLAY, browser is
  launched per script run (no persistent daemon yet), `egoAutomated` CDP
  domain is a no-op in stock Chromium (harness tolerates it).
- 2026-11-05 (v2 hardening, "go go go"): `ego-linux.mjs` upgraded:
  - Snapshot: viewport filter via `DOM.getBoxModel` (FULL shows Top+Bottom,
    VIEWPORT shows only TopBtn + harness "more content" note), prune
    `InlineTextBox` bloat, subtree scope works (only `Inside`, no `Outside`).
  - Iframes: AX tree stops at `Iframe` in stock Chromium, so merge
    `DOM.getDocument(pierce:true)` contentDocuments + OOPIF targets.
    Verified click inside iframe (`before → after`) — ego's key differentiator.
  - Dialogs: harness detects `alert` and throws `PageDialogOpenedError`;
    `acceptDialog()` flow verified (`alerted` in snapshot).
  - Keyboard: `keyboard.press/type` verified (`abhello`).
  - `@ref` click verified (`before → after-ref`).
  - User-control: `handOff()` correctly triggers harness hard-stop with
    `EGO_TASK_SPACE_USER_IN_CONTROL` (upstream design: agent must stop).
  - Attach mode: `EGO_LINUX_CDP_URL=http://127.0.0.1:19400` attaches to a
    running Chrome, browser stays alive after run, clean exit (fixed
    WebSocket-keeps-Node-alive hang). Also `EGO_LINUX_KEEP_BROWSER=1`,
    `EGO_LINUX_HEADLESS=0`, auto-detect chromium/google-chrome/Playwright.
  - Packaging: `ego-linux --help`, `ego-linux skill`, README.md, installed
    symlink `~/.local/bin/ego-linux -> ~/egolite_build/ego-linux.mjs`.
  - Re-ran upstream `npm test`: **609/609 pass** again.
  - Disk after all checks: **29 GB free** (floor 15 GB, respected throughout).
  Remaining gaps: no native action-marks/locator backfill (stock Chromium
  has no forked snapshot), single Default profile (use attach mode to share
  a real logged-in Chrome), browser per run unless keep/attach mode.
- 2026-11-05 (V3, "all native features"): `ego-linux.mjs` upgraded:
  - **Persistent daemon** (biggest native parity win): first run spawns a
    daemon (browser + Spaces) on `~/.local/share/ego-linux/daemon.sock`;
    subsequent runs attach to it. Verified Space `persist-demo` created in
    run 1 is reused in run 2 with tabs/page intact, `ego-linux status`
    lists Spaces, `ego-linux stop` shuts down. Fixed Node socket half-close
    bug (`allowHalfOpen` + delimiter protocol). `EGO_LINUX_NO_DAEMON=1`
    keeps single-run mode. Like the Mac app: browser always running,
    agent connects per task.
  - **Chrome import** (`ego-linux import-chrome [DIR]`): migrates logins/
    cookies/history from `~/.config/google-chrome/Default` into the
    ego-linux profile, with lock check (Chrome must be closed) and disk
    guard (refuses if free would drop below 15 GB). Verified with a test
    profile. This replicates the Mac onboarding "migrate Chrome data" step.
  - **Native UI parity**: `setAgentTaskState` shows a top-left "ego: …"
    bar, `animationHighlightMouseToPosition` draws a red ring at (x,y) —
    both `aria-hidden` + `pointer-events:none` so they don't pollute
    snapshots or block clicks (verified). Real `getBrowserVersion`
    (`154.0.8037.92`), `listProfiles` scans real Chrome profile dirs,
    `createTaskSpace(profileId)` validates with `EGO_PROFILE_NOT_FOUND`,
    anti-automation launch flag `--disable-blink-features=AutomationControlled`.
  - **Snapshot quality**: locators now quoted (`[name="Go"]`, survives
    spaces/commas, validator-safe), iframe/viewport/subtree from V2 kept.
  - Re-ran everything: fill/click by quoted loc (`ok:Bob`), iframe click,
    dialog, keyboard, `@ref`, viewport, multi-Space, attach mode, daemon
    persistence, import, highlight — all pass. Upstream `npm test`:
    **609/609 pass**. Disk: **29 GB free** throughout (floor 15 GB).
  Remaining gaps vs closed Mac app (cannot be closed without the fork):
  custom Chromium snapshot engine (action-marks, native stable-locator
  backfill, SnapshotSubtree flag), `egoAutomated` anti-detect CDP domain,
  and the native Spaces UI chrome (we have headed mode + in-page state bar
  instead). Everything documented in the bridge spec is implemented.
- 2026-11-05 (critique + RE + V4): user asked for hard critique, GUI port,
  and reverse-engineering the closed fork. See `REVERSE-ENGINEERING.md`
  for the full binary analysis. Critique of V3 and fixes in V4:
  - V3 had **no GUI** -> V4 adds a local web dashboard ("ego home"
    equivalent) served by the daemon on `127.0.0.1:8765`: Spaces list,
    screenshot (live, 3s refresh), snapshot, navigate, handOff/takeOver/
    finish/close, create Space. Verified via curl + API (Space created
    in GUI appears in CLI `status` and vice versa).
  - V3 had **no crash recovery / logs to nowhere** -> V4: browser exit
    shuts the daemon down cleanly for a fresh respawn, daemon logs to
    `~/.local/share/ego-linux/daemon.log`, stale-socket handling kept.
  - V3 missed **undocumented native methods** found in the fork binary
    (`markTaskSpaceError`, `deleteSpaces`) -> implemented both, with
    `lastError` surfaced in `listTaskSpaces`/GUI.
  - V3 overlay polluted snapshots -> `aria-hidden` + `pointer-events:none`
    (verified clean). Duplicate Iframe line remains cosmetic only.
  - V3 had no installer/tests -> added `install.sh` (disk guard, build,
    symlink, smoke) and `tests/smoke.sh` (fill/click, iframe, viewport,
    GUI API, upstream `npm test`).
  - Headed mode verified under Xvfb (`EGO_LINUX_HEADLESS=0 xvfb-run …`):
    snapshot + screenshot pass, so a visible browser window works.
  - RE findings baked in: Chromium 156.0.8078.74 base, `egoAutomated`
    domain, `SnapshotSubtree` flag, Omaha4 updater (`com.citrolabs.ego.lite`,
    `update.citrolabs.ai`), Node daemon + web GUI architecture — all
    documented in `REVERSE-ENGINEERING.md` with the port mapping.
  - Disk after RE (downloaded 149 MB DMG + 18 MB installer, extracted
    433 MB, then cleaned all binaries): **29 GB free**, floor respected.
  Final product shape: `ego-linux` CLI + persistent daemon + GUI at
  `:8765` + headed/attach modes + Chrome import, in
  `~/egolite_build/` with `GOAL.md`, `README.md`,
  `REVERSE-ENGINEERING.md`, `install.sh`, `tests/smoke.sh`.
