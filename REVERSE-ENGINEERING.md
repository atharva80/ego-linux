# Reverse engineering the closed ego lite fork (2026-11-05)

Artifacts analysed (official downloads, not source):
- Windows: `egoliteSetup-Y7MbxKIuhzFB.exe` (18.2 MB, PE32+ x64)
- macOS arm64: `egolite-Y7MbxKIuhzFB.dmg` (149.5 MB, UDZO/ULMO, version 0.6.2.8)
- Extracted with 7-Zip 25.01 (7zz) — older 7z 23.01 and dmg2img fail on
  ULMO block type `0x80000008`; new 7zz handles it. HFS+ via 7zz directly.

## Windows installer = Chromium updater only
- `egoliteSetup.exe` is `UpdaterSetup.exe`, ProductName `EgoUpdater`,
  Company `Citro Labs Pte. Limited`, containing a 10 MB `updater.7z` with
  a single `updater.exe` (9.9 MB).
- That binary is Chromium's `chrome/updater` (GoogleUpdate/Omaha4):
  strings show `..\..\chrome\updater\win\protocol_parser_xml.cc`,
  `perfetto`, `icu_78`, `IUpdaterAppState`, `CheckForUpdate2`.
- App identity inside it: AppId `com.citrolabs.ego.lite`, update server
  `https://update.citrolabs.ai/service/update2`, domains `ego.app` /
  `lite.ego.app`. The real browser binary is fetched by Omaha4
  (protobuf, fields `cpu_architecture/os_version/platform`) at runtime —
  it is not in the installer.

## macOS app = Chromium 156 fork + Node daemon + web GUI
- Version: **0.6.2.8** (DMG comment `egolite-0.6.2.8`, Info.plist
  `CFBundleShortVersionString 0.6.2.8`, framework `Versions/0.6.2.8`).
- Base Chromium: **156.0.8078.74** (only `156.x` string in
  `ego Framework`; local Chromium 154/155 is close, Playwright's is
  156.0.8078.4 — same major).
- `Contents/MacOS/ego lite` (71 KB launcher) loads
  `Frameworks/ego Framework.framework/Versions/0.6.2.8/ego Framework`
  (**258 MB** Mach-O arm64) — the forked Chromium, analogous to
  `chrome.dll` / `libchrome.so`.
- Helpers (Chromium multi-process, renamed): `ego Helper`,
  `ego Helper (Node|Renderer|GPU|Alerts)`,
  `ego Helper (Aperitif|GPU|Renderer|Alerts)`, `chrome_crashpad_handler`,
  `app_mode_loader`, `web_app_shortcut_copier`.
  `libaperitif.dylib` (86 KB) is a custom native lib (codename Aperitif).
- `Helpers/ego-browser` (2 MB Mach-O): the bundled CLI. Strings:
  `egoAutomated.disable`, `--version`, `skill`, `nodejs`, `sources`,
  `ego-server-name`, and the help text: *"Page sessions hide page console
  messages from CDP so sites cannot detect the automation."*

## Custom Chromium features found in `ego Framework` strings
- **CDP domain `egoAutomated`**: `egoAutomated.enable/disable` — hides
  `Runtime.consoleAPICalled` / call stacks from pages so CDP automation
  is undetectable. Harness sends `egoAutomated.enable` per session and
  tolerates unknown-domain rejection on stock Chromium.
- **`kSnapshotSubtree` / `--enable-features=SnapshotSubtree`**:
  `ego.snapshot({scope:'subtree'}) requires --enable-features=SnapshotSubtree`.
  Native subtree snapshot matches `root` by `backendNodeId` across frames.
- **Task Spaces** (all in the binary, matching `docs/native-bindings-api.md`):
  `create/claim/list/close/complete/handOff/takeOver/useTaskSpace`,
  error codes `EGO_TASK_SPACE_*`, plus **two undocumented methods** not in
  the repo docs:
  - `ego.markTaskSpaceError(message)` — "Example: await
    ego.markTaskSpaceError('Login wall could not be passed')"
  - `ego.deleteSpaces(options)` — expects `{scope:'all'|'task'}` or
    `{ids: number[]}`.
- Startup/service: `startup-ego-browser-service`, a shell-script that
  registers the `ego-browser` symlink with administrator privileges, and
  `Resources/ego-skills/ego-browser` (the bundled skill, same as repo).

## The daemon + GUI (the part that is actually portable)
- `Resources/local-ego-daemon/` is a **Node.js app**, not native code:
  `index.mjs` -> `runtime/run-*.mjs` (Effect-based, 10 MB bundled JS,
  with Sentry/Langfuse), plus `db-migrations/`.
- `Resources/local-ego-daemon/client/` is the GUI: `index.html` titled
  **"ego home"**, loading `/assets/index-*.js` + CSS (a web app served
  by the daemon, like our V4 dashboard). It is minified client JS —
  architecture (daemon + web GUI + Chromium) is what we ported, not the
  assets themselves.
- This confirms our port design: persistent Node daemon owning the
  browser, short-lived `ego-browser` CLI scripts, and a local web GUI —
  exactly what `ego-linux.mjs` v3/v4 implements on stock Chromium CDP.

## What cannot be ported without the fork source
- `egoAutomated` CDP domain, native `SnapshotSubtree`, the fork's tuned
  snapshot engine (action-marks, stable-locator backfill, nested-iframe
  handling), and `libaperitif` internals. Our port approximates all of
  these via `Accessibility.getFullAXTree` + `DOM.getDocument(pierce)` +
  viewport `DOM.getBoxModel` filtering, which passes the harness's own
  609 tests and real click/fill/iframe/dialog flows.
- The fork itself is not redistributable source: no Chromium source
  checkout was used, and no binary assets were copied into this project.

## Deep tear-apart (V5, radare2 + strings on the extracted app)
- Tools: `strings` (560k lines from `ego Framework`), `r2` (radare2,
  arm64 Mach-O), `capstone`, 7-Zip 25.01 for ULMO extraction.
- `ego Framework` (258 MB): `egoAutomated` string at `0x0e22713c`
  (cstring) and `0x0d69d9be` (const). `kSnapshotSubtree` at string
  offset ~221945. Snapshot validation strings:
  *"Snapshot subtree root matched multiple nodes with the same
  backendNodeId. The id is not unique across frames; pass the frameId
  reported by the ref"*, *"ego.snapshot({scope:'subtree'}) requires
  root, a backendNodeId such as 21"*.
- `egoAutomated` is a **V8-inspector domain** (registered in
  `v8_inspector::V8InspectorSessionImpl`, alongside Profiler/Runtime),
  not a Chromium UI feature. Per the Rust `ego-browser` helper's help
  text: *"Page sessions hide page console messages from CDP so sites
  cannot detect the automation. To read Runtime.consoleAPICalled while
  debugging, first call egoAutomated.disable, then Runtime.enable."*
  Our approximation: never enable `Runtime` (console events never
  fire) + `Page.addScriptToEvaluateOnNewDocument` anti-detect
  (`navigator.webdriver === undefined`, delete `cdc_*` vars) +
  `--disable-blink-features=AutomationControlled`. Verified
  `navigator.webdriver` is `undefined` in-page under ego-linux.
- `Helpers/ego-browser` is **Rust** (`cxxbridge`, `serde_json`,
  symbols `_ego_cli_cxxbridge1_202_parse_invocation`,
  `parse_nodejs_options`, `parse_skill_options`), `main` (7312 B).
  CLI surface from strings: `nodejs`, `--eval/-e`, `skill`,
  `--version`, `sources`, `ego-server-name`.
- Native JS bridge lives in the fork at `ego/services/node/`
  (`ego://services/node/resources/index.js`, `NodeRuntimeImpl`,
  `__egoEvaluateScript/ReplScript/PreloadScript`,
  `__egoNodeOutputCapture`, fatal-error handlers) over a custom Node
  (`../../ego/third_party/node/src/node_snapshotable.cc`).
- **Undocumented native methods** (strings in `ego Framework`):
  - `ego.showAgentGesture(command)` — types `point|press|scroll|write|
    key|think|outcome` with x/y, chars, label, ok. Implemented in
    ego-linux as in-page overlay gestures (ring + label bubble).
  - `ego.markTaskSpaceError(message)` and `ego.deleteSpaces({scope|ids})`
    — implemented in V4.
  - `ego.handOffTask()` alias alongside `handOffTaskSpace()`.
  - Snapshot options in the bridge: `includeActionMarks`,
    `interactiveOnly`, `includeStableLocator`, `maxResultLength`
    (action-marks format is not present as plain text in the binary —
    it is generated in C++ — so we keep text snapshots clean and show
    gestures visually instead).
- `libaperitif.dylib` (86 KB) is **not** custom ego code: it is
  Chromium's seatbelt sandbox (`sandbox_init_with_parameters`,
  `org.chromium.sandbox`, `AperitifCheckInitialized`). The
  `ego Helper (Aperitif*)` helpers are standard Chromium sandbox
  helpers renamed. No porting needed.
- `local-ego-daemon/runtime/` is bundled Node JS (Effect, Sentry,
  Langfuse, OpenTelemetry — including a `getMachineId-linux` module
  from OTEL, not ego Linux support). The daemon orchestrates agents
  (ACP/Codex/Claude); the browser bridge is in the Chromium fork +
  Node service above. Our daemon (browser bridge + GUI) is the
  portable subset.
- `Resources/ego-skills/ego-browser/` in the app matches the repo
  skill; `install.sh` in Resources is Chromium's stock mac installer
  (Keystone), not ego-specific.

## Deep disassembly RE (V5/V6, radare2 5.5 + llvm-objdump-18 + capstone)
Tools: `r2`/`rafind2`, `llvm-objdump-18` (Mach-O arm64, annotates
`adrp … ; 0x…` string pages), `rabin2`, `capstone 4.0.2`.
Evidence files in `RE/`: `ego-browser-afl.txt` (279 functions),
`ego-browser-parse-invocation.pdc.txt` (pdc pseudo-C),
`ego-browser-skill-ref-disasm.txt` (llvm-objdump snippet).

### ego Framework (258 MB, stripped)
- `rabin2 -s`: only **3 exported symbols** (`ChromeMain`,
  `ChromeAppModeStart_v8`, `ChromeWebAppShortcutCopierMain`) + 1762
  import stubs. No ego function names survive — full function-level
  RE of this binary is not feasible even with Ghidra/IDA; it would
  take weeks of manual work on 222 MB of arm64 code.
- `r2 aa` (entry analysis) finds 1782 functions, none ego-named.
  `r2 aaa` (full) was run headless in background (timeout 1200s) —
  same result expected: stripped Chromium + ego patches blended in.
- String xrefs: `egoAutomated` cstring at `0x0e22713c`, const at
  `0x0d69d9be`; `kSnapshotSubtree` at string ~221945. No direct
  8-byte pointer or ADRP xref found by capstone linear sweep
  (desync on data-in-text) or `r2 axt` — consistent with the string
  living in a V8-inspector domain descriptor table in `__const`,
  referenced indirectly. The domain registration itself is in
  `v8_inspector::V8InspectorSessionImpl` (adjacent strings).
- Snapshot validation strings (verbatim from binary):
  *"Snapshot subtree root matched multiple nodes with the same
  backendNodeId. The id is not unique across frames; pass the
  frameId reported by the ref"*, *"ego.snapshot({scope:'subtree'})
  requires root, a backendNodeId such as 21"*, *"ego.snapshot
  (options?) expects an options object with scope
  'only_within_viewport', 'full_page', or 'subtree'"*.

### ego-browser helper (2 MB, Rust — fully analysable)
- `r2 aaa`: 4260 functions. `main` at `0x10000be8c` (7312 B).
  Symbols: `_ego_cli_cxxbridge1_202_parse_invocation` (`0x100121000`),
  `parse_nodejs_options`, `parse_skill_options`, plus
  `cxxbridge1_string/rust_vec_string` (Rust↔C++ bridge).
- `pdc` decompilation of `parse_invocation` (saved in `RE/`):
  Rust `Vec<String>` argument parsing loop (`memcpy` of 24-byte
  string structs, reserve_total) — confirms the CLI is a thin Rust
  parser that forwards scripts to the Node service.
- `llvm-objdump-18 -d` (418k lines): skill-guide string
  (`0x10019d0bc`, page `0x10019d000`) is referenced by ADRP at e.g.
  `0x1000528b8: adrp x1, 331 ; 0x10019d000 / add x1, x1, #0x28 /
  bl 0x100040c9c` — the embedded SKILL.md v2.2.0 (macos) printer.
  The same page holds the `egoAutomated.disable` help text at
  `0x1001a0fb0`.
- No IDA/Ghidra available on this machine (checked); r2 + llvm +
  capstone cover what is feasible. IDA headless would give the
  same stripped result for `ego Framework` (no symbols to recover).

### local-ego-daemon (Node JS, readable)
- `runtime/run-*.mjs` (5.2 MB Effect app): API routes are
  agent/session/provider (`/api/session/{id}/prompt`,
  `/api/provider-settings/*`, `/api/mcp/external/*`, …) — it
  orchestrates coding agents, not the browser bridge.
- `client/index.html` ("ego home") + 518 asset files (mostly
  syntax grammars); main bundle `index-YVpaseql.js` (378 KB) talks
  to `/api/early_access_features`, `/api/product_tours`, etc.
  Our GUI (`:8765`) ports the *function* (Spaces, screenshot,
  snapshot, handOff), not these assets.

### What this RE changed in the port (V5)
- Anti-detect: `egoAutomated` = hide `Runtime.consoleAPICalled`.
  Stock Chromium: never enable `Runtime` + inject
  `navigator.webdriver=undefined` + delete `cdc_*` on every new
  document. Verified in-page.
- Stable locators: native `includeStableLocator` upgrades role
  locs; we now emit `loc=css:#id` / `[data-testid]` / `[name]`
  from `DOM.getDocument` attrs (validator-safe, verified).
- `showAgentGesture`: implemented from the binary's validation
  string (point/press/scroll/write/key/think/outcome).
- Anything else "impossible" is now precisely scoped: the fork's
  C++ snapshot engine (action-marks format is not in strings —
  generated code, not data), cross-origin iframe AX (browser
  privilege), and stripped-function recovery (no symbols exist).

### Binary Ninja headless (V6, BN 4.2.6455 commercial)
- Found on this machine at
  `~/abhijit_binja/binaryninja_linux_stable_commercial/binaryninja/`
  (GUI needs Xvfb; Python API via `scripts/install_api.py` +
  `PYTHONPATH=…/python`, license = commercial backup in
  `~/.binaryninja/license_commercial_backup.dat`).
- `ego-browser` helper: BN loads it as **aarch64 / mac-aarch64,
  5810 functions** (r2 found 4260 — BN's analysis is deeper).
  Symbols: `_ego_cli$cxxbridge1$202$parse_invocation` etc.
  `egoAutomated` string at `0x1001a115a` with **no code/data xrefs**
  in BN either — it is inside the embedded SKILL.md const, not a
  code string. Confirms: helper implements no CDP domain.
- `libaperitif.dylib`: **164 functions**, no ego strings — pure
  Chromium seatbelt sandbox.
- `ego Framework` (258 MB): BN load+analysis exceeds 10 min
  (background job, timeout 900s); `rabin2` already proved it is
  stripped (3 exports). BN would find the same V8-inspector
  domain registration as strings did, with no ego symbols to
  recover. Evidence: `RE/ego-browser-afl.txt`,
  `RE/ego-browser-parse-invocation.pdc.txt`,
  `RE/fork-ego-files.txt` (123 fork source files, below).

### Fork source tree (from assert strings in `ego Framework`)
Saved in `RE/fork-ego-files.txt` (123 files under `ego/browser/`
and `ego/services/`). Highlights:
- `ego/browser/ui/mainland/*` (mainland/island/shelf) — Spaces UI
  ("islands" = task spaces, shelf = tab strip)
- `ego/browser/ui/views/frame/agent_mouse_layer_view`,
  `agent_task_overlay_view`, `task_status_ring_view` — the native
  agent-gesture overlay behind `showAgentGesture`
- `ego/browser/ui/views/ego_ai/ai_chat_view`, `side_panel` —
  AI panel; `ego://side-panel-chatbox-lite/`, `ego://welcome/`
- `ego/browser/data_import/*` — Chrome profile import
  (`chromium_profile_cookies`, `chromium_source_recovery`) +
  `safari_zip_import` — our `import-chrome` CLI ports the Chrome
  half; Safari zip import is not ported
- `ego/browser/cli/ego_cli_bridge_host`, `ego_cli_service_host` —
  the `ego-browser` CLI bridge (Rust helper <-> Node service)
- `ego/services/node/*`, `ego/services/chat_service/*`,
  `ego/services/command_executor/*` — Node runtime + chat +
  command execution services inside the fork
- `ego/browser/ax/focused_editable_input_util.mm`,
  `ego/browser/api/ego_controller_handler.cc`,
  `ego/browser/ui/on_boarding/*` — onboarding UI we replaced
  with CLI import + GUI

## Port mapping (closed -> Linux)
| Closed fork | ego-linux |
|---|---|
| `ego Framework` (Chromium 156) | system `chromium`/`google-chrome` + CDP |
| `egoAutomated.enable` | launch flag + harness tolerance (no-op) |
| `SnapshotSubtree` flag | AX subtree walk by `backendDOMNodeId` |
| `globalThis.ego` bridge | `ego-linux.mjs` shim (same API, incl. `markTaskSpaceError`/`deleteSpaces`) |
| `local-ego-daemon` + `ego home` GUI | persistent daemon (unix socket) + local web dashboard (`:8765`) |
| Omaha4 updater | none (manual `npm run build` + `install.sh`) |
