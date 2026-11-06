#!/usr/bin/env node
// ego-linux v2: reimplementation of the closed Ego Lite native bridge
// (globalThis.ego, spec in ego-lite/docs/native-bindings-api.md) on stock
// Linux Chromium CDP, so the open-source ego-browser harness runs unmodified.
// Modes:
//   EGO_LINUX_CDP_URL=ws://...  attach to an already-running Chrome (shared logged-in browser)
//   EGO_LINUX_HEADLESS=0        headed (needs DISPLAY / Xvfb)
//   EGO_LINUX_KEEP_BROWSER=1    do not kill Chromium on exit (persistent daemon)
//   EGO_LINUX_PROFILE=DIR       persistent profile (cookies/logins survive runs)
//   CHROME_PATH=/path/to/chrome override binary (auto-detected otherwise)
import { spawn, execSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import net from "node:net";

const VERSION = "4.0.0";
let EMBEDDED_BUNDLE_B64 = null, EMBEDDED_SKILL_B64 = null; // injected by build-single.sh
const argv = process.argv.slice(2);
const ROOT = dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = join(homedir(), ".local/share/ego-linux");
const DAEMON_SOCK = join(DAEMON_DIR, "daemon.sock");
const BUNDLE = process.env.EGO_BROWSER_BUNDLE || join(ROOT, "ego-lite/package/ego-browser/dist/out/index.js");
const SKILL_FILE = join(ROOT, "ego-lite/package/ego-browser/dist/out/ego-browser/SKILL.md");
async function loadBundle() {
  if (EMBEDDED_BUNDLE_B64) {
    const { createHash } = await import("node:crypto");
    const { writeFileSync } = await import("node:fs");
    const hash = createHash("sha256").update(EMBEDDED_BUNDLE_B64).digest("hex").slice(0, 16);
    const dir = join(DAEMON_DIR, "harness"); mkdirSync(dir, { recursive: true });
    const p = join(dir, `ego-browser-${hash}.mjs`);
    if (!existsSync(p)) writeFileSync(p, Buffer.from(EMBEDDED_BUNDLE_B64, "base64"));
    return import(pathToFileURL(p).href);
  }
  return import(pathToFileURL(BUNDLE).href);
}
function loadSkillText() {
  if (EMBEDDED_SKILL_B64) return Buffer.from(EMBEDDED_SKILL_B64, "base64").toString("utf8");
  try { return readFileSync(SKILL_FILE, "utf8"); } catch { return readFileSync(join(ROOT, "ego-lite/package/ego-browser/skill-body/SKILL.md"), "utf8"); }
}
if (argv.includes("--version") || argv[0] === "version") {
  let chromeVer = "not found"; try { chromeVer = execSync("chromium --version 2>/dev/null || google-chrome --version 2>/dev/null || echo not found").toString().trim(); } catch {}
  console.log(`ego-linux ${VERSION}\nnode ${process.version} (need >=22)\nchromium: ${chromeVer}\nbundle: ${EMBEDDED_BUNDLE_B64 ? "embedded (single-file)" : BUNDLE}`);
  process.exit(0);
}

if (argv.includes("-h") || argv.includes("--help")) {
  console.log(`ego-linux v3 — ego lite (browser harness) for Linux, on stock Chromium CDP

Usage:
  ego-linux <<'JS'        # pipe agent JS on stdin (taskSpace/page helpers)
  ego-browser nodejs <<'JS'   # same, ego-browser CLI compatibility
  ego-browser nodejs -e 'JS'   # inline script
  ego-linux skill          # print the ego-browser skill guide
  ego-linux status         # list Spaces in the persistent daemon
  ego-linux stop           # stop the daemon + browser
  ego-linux import-chrome [DIR]  # migrate Chrome logins/cookies (close Chrome first)
  ego-linux --help

A persistent daemon (browser + Spaces) starts on first run and survives
between calls, like the Mac app. Disable it with EGO_LINUX_NO_DAEMON=1.

Env:
  EGO_LINUX_CDP_URL       attach to running Chrome instead of launching one
  EGO_LINUX_HEADLESS=0    headed mode (DISPLAY/Xvfb) — watch Py agent work, take over
  EGO_LINUX_KEEP_BROWSER=1 keep Chromium alive after the run
  EGO_LINUX_PROFILE=DIR   persistent profile dir (default ~/.local/share/ego-linux/profile)
  CHROME_PATH             chromium binary (auto-detected: chromium, google-chrome, Playwright)`);
  process.exit(0);
}
if (argv[0] === "skill") {
  console.log(loadSkillText());
  process.exit(0);
}
if (argv[0] === "import-chrome") {
  const src = argv[1] || [join(homedir(), ".config/google-chrome/Default"), join(homedir(), ".config/chromium/Default")].find(p => existsSync(p));
  const dest = process.env.EGO_LINUX_PROFILE || join(DAEMON_DIR, "profile");
  if (!src || !existsSync(src)) { console.error("No Chrome profile found. Pass a dir: ego-linux import-chrome ~/.config/google-chrome/Default"); process.exit(1); }
  if (existsSync(join(src, "SingletonLock")) || existsSync(join(dirname(src), "SingletonLock"))) { console.error("Chrome is running — close it first, then import."); process.exit(1); }
  const freeKB = Number(execSync("df --output=avail -k /home/atharva/egolite_build").toString().trim().split("\n").pop());
  const srcKB = Number(execSync(`du -sk ${JSON.stringify(src)}`).toString().split(/\s/)[0]);
  console.log(`profile ${src} = ${(srcKB / 1024).toFixed(0)} MB, free = ${(freeKB / 1024 / 1024).toFixed(1)} GB`);
  if (freeKB - srcKB < 15 * 1024 * 1024) { console.error("Refusing import: would drop free space below 15 GB floor."); process.exit(1); }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, force: true, filter: (s) => !/(SingletonLock|SingletonSocket|SingletonCookie|lockfile|DevToolsActivePort)$/.test(s) });
  console.log(`Imported Chrome profile into ${dest} (logins, cookies, history). Stop any running daemon, then run ego-linux again.`);
  process.exit(0);
}
const SERVE = argv[0] === "serve";
const NO_DAEMON = process.env.EGO_LINUX_NO_DAEMON === "1" || !!process.env.EGO_LINUX_CDP_URL || SERVE;
async function daemonRequest(code) {
  const { default: netMod } = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = netMod.createConnection({ path: DAEMON_SOCK, allowHalfOpen: true });
    let out = ""; s.setEncoding("utf8");
    s.on("data", d => out += d); s.on("end", () => resolve(out)); s.on("error", reject);
    s.write(code + "\n\x00END\x00\n");
  });
}
async function daemonAlive() { try { await daemonRequest("console.log('__ping__')"); return true; } catch { return false; } }
if (!SERVE && argv[0] === "stop") {
  try { const r = await daemonRequest("__STOP__"); console.log(r || "daemon stopped"); } catch { console.log("daemon not running"); }
  try { rmSync(DAEMON_SOCK, { force: true }); } catch {}
  process.exit(0);
}
if (!SERVE && argv[0] === "gui" && !NO_DAEMON) {
  if (!(await daemonAlive())) {
    mkdirSync(DAEMON_DIR, { recursive: true });
    const { openSync } = await import("node:fs");
    const logFd = openSync(join(DAEMON_DIR, "daemon.log"), "a");
    const d = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: ["ignore", logFd, logFd] });
    d.unref();
    for (let i = 0; i < 50 && !(await daemonAlive()); i++) await new Promise(r => setTimeout(r, 100));
  }
  const port = process.env.EGO_LINUX_GUI_PORT || "8765";
  const url = `http://127.0.0.1:${port}/`;
  console.log(`ego-linux GUI: ${url}`);
  try { spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref(); } catch {}
  process.exit(0);
}
if (!SERVE && argv[0] === "status" && !NO_DAEMON) {
  if (await daemonAlive()) { const r = await daemonRequest("console.log(JSON.stringify(await listTaskSpaces(), null, 2))"); process.stdout.write(r.replace(/\n__EXIT__:\d+\n?$/, "\n")); }
  else console.log("daemon not running (next ego-linux run will start it)");
  process.exit(0);
}
// ego-browser CLI compatibility (RE: Rust helper surface):
//   ego-browser nodejs [-e CODE | FILE] [--sdk-path PATH] [stdin]
//   ego-browser skill | --version | -h
// Invoked as "ego-browser" (symlink), bare args are treated as nodejs.
let CLI_CODE = null, CLI_SDK_PATH = null;
{
  const prog = (process.argv[1] || "").includes("ego-browser") ? "ego-browser" : "ego-linux";
  let args = argv.slice();
  if (prog === "ego-browser" && args[0] !== "nodejs" && !["skill", "status", "stop", "gui", "import-chrome", "serve", "--help", "-h", "--version", "version"].includes(args[0])) args = ["nodejs", ...args];
  if (args[0] === "nodejs") {
    args = args.slice(1);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e" || args[i] === "--eval") CLI_CODE = args[++i] ?? "";
      else if (args[i] === "--sdk-path") CLI_SDK_PATH = args[++i] ?? null;
      else if (args[i].startsWith("--sdk-path=")) CLI_SDK_PATH = args[i].slice(11);
      else if (!args[i].startsWith("-")) { try { CLI_CODE = readFileSync(args[i], "utf8"); } catch (e) { console.error(`ego-browser: cannot read ${args[i]}: ${e.message}`); process.exit(2); } }
    }
    if (CLI_SDK_PATH) process.env.EGO_BROWSER_BUNDLE = CLI_SDK_PATH;
  }
}
if (!SERVE && !NO_DAEMON && argv[0] !== "status" && argv[0] !== "gui") {
  if (!(await daemonAlive())) {
    mkdirSync(DAEMON_DIR, { recursive: true });
    const { openSync } = await import("node:fs");
    const logFd = openSync(join(DAEMON_DIR, "daemon.log"), "a");
    const d = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], { detached: true, stdio: ["ignore", logFd, logFd] });
    d.unref();
    for (let i = 0; i < 50 && !(await daemonAlive()); i++) await new Promise(r => setTimeout(r, 100));
  }
  const code = CLI_CODE ?? readFileSync(0, "utf8");
  const resp = await daemonRequest(code);
  const m = resp.match(/\n__EXIT__:(\d+)\n?$/);
  if (m) { process.stdout.write(resp.slice(0, m.index + 1)); process.exit(Number(m[1])); }
  process.stdout.write(resp); process.exit(0);
}

function detectChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const c of ["chromium", "google-chrome", "google-chrome-stable", "chromium-browser"]) {
    try { execSync(`command -v ${c}`, { stdio: "ignore" }); return c; } catch {}
  }
  try {
    const p = execSync("ls ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1", { shell: "/bin/bash" }).toString().trim();
    if (p && existsSync(p)) return p;
  } catch {}
  return "chromium";
}
const PROFILE = process.env.EGO_LINUX_PROFILE || join(homedir(), ".local/share/ego-linux/profile");
const HEADLESS = process.env.EGO_LINUX_HEADLESS !== "0";
const ATTACH_URL = process.env.EGO_LINUX_CDP_URL || null;
const KEEP = process.env.EGO_LINUX_KEEP_BROWSER === "1" || !!ATTACH_URL;

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });
}

let child = null;
const kill = () => { if (child && !KEEP) { try { child.kill(); } catch {} } };
process.on("exit", kill); process.on("SIGINT", () => { kill(); process.exit(1); });

let wsUrl = ATTACH_URL;
if (!wsUrl) {
  const chromeBin = detectChrome();
  let chromeOk = false; try { execSync(`command -v ${chromeBin} >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1`); chromeOk = true; } catch {}
  if (!chromeOk && !existsSync(chromeBin)) {
    console.error(`ego-linux: no Chromium/Chrome found.\nInstall on Ubuntu/GNOME:\n  sudo apt update && sudo apt install chromium-browser\nor download Google Chrome from https://www.google.com/chrome/\nThen re-run. Set CHROME_PATH=/path/to/chrome to override.`);
    process.exit(1);
  }
  const port = await freePort();
  mkdirSync(PROFILE, { recursive: true });
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--mute-audio", "--disable-blink-features=AutomationControlled", ...(HEADLESS ? ["--headless=new", "--hide-scrollbars", "--window-size=1280,800"] : ["--window-size=1280,800"]), "about:blank"];
  child = spawn(detectChrome(), args, { stdio: "ignore" });
  // Keep the browser alive across runs in daemon mode: detach so killing
  // this node process on exit does not take Chromium down with it.
  if (KEEP) child.unref?.();
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
} else if (ATTACH_URL.startsWith("http")) {
  const r = await fetch(`${ATTACH_URL.replace(/\/$/, "")}/json/version`); wsUrl = (await r.json()).webSocketDebuggerUrl;
}
if (!wsUrl) throw new Error("Chromium CDP did not come up");

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextLocal = 900000;
const localPending = new Map();
ws.onmessage = (ev) => {
  const data = typeof ev.data === "string" ? ev.data : String(ev.data);
  let msg; try { msg = JSON.parse(data); } catch { return; }
  if (msg.id && localPending.has(msg.id)) {
    const p = localPending.get(msg.id); localPending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result ?? msg);
    return;
  }
  ego.onCDPMessage?.(data);
};
function cdpCall(method, params = {}, sessionId) {
  const id = nextLocal++;
  return new Promise((resolve, reject) => {
    localPending.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e) { localPending.delete(id); return reject(e); }
    setTimeout(() => { if (localPending.has(id)) { localPending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 15000);
  });
}
const err = (code, msg) => { const e = new Error(msg); e.error_code = code; return e; };

const tasks = new Map(); let nextTask = 1; let selected = null;
const sessions = new Map();
async function taskTabs(task) {
  const { targetInfos } = await cdpCall("Target.getTargets");
  return targetInfos.filter(t => t.type === "page" && t.browserContextId === task.browserContextId);
}
async function ensureTab(task, url = "about:blank") {
  const tabs = await taskTabs(task);
  if (tabs.length) {
    const act = task.activatedTargetId && tabs.find(t => t.targetId === task.activatedTargetId);
    return act || tabs[tabs.length - 1];
  }
  const { targetId } = await cdpCall("Target.createTarget", { url, browserContextId: task.browserContextId });
  task.activatedTargetId = targetId;
  return { targetId, url, title: "", type: "page" };
}
const ANTI_DETECT = `(()=>{try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});}catch(e){} try{for(const k of Object.keys(window)){if(k.indexOf('cdc_')===0){try{delete window[k]}catch(e){}}}}catch(e){}})()`;
async function attach(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const { sessionId } = await cdpCall("Target.attachToTarget", { targetId, flatten: true });
  sessions.set(targetId, sessionId);
  // egoAutomated approximation: stock Chromium has no such CDP domain, so
  // hide automation signals in-page (webdriver flag, cdc_ console vars).
  // Console messages are already hidden from CDP because we never enable
  // the Runtime domain (same effect as the fork's egoAutomated.enable).
  cdpCall("Page.addScriptToEvaluateOnNewDocument", { source: ANTI_DETECT }, sessionId).catch(() => {});
  cdpCall("Runtime.evaluate", { expression: ANTI_DETECT, returnByValue: true }, sessionId).catch(() => {});
  return sessionId;
}

const INTERACTIVE = new Set(["button","link","textbox","searchbox","checkbox","radio","combobox","listbox","menuitem","menuitemcheckbox","menuitemradio","slider","spinbutton","switch","tab","treeitem","option"]);
const SKIP_ROLES = new Set(["InlineTextBox"]);

async function viewportRect(sessionId) {
  try {
    const r = await cdpCall("Runtime.evaluate", { expression: "({x:scrollX,y:scrollY,w:innerWidth,h:innerHeight})", returnByValue: true }, sessionId);
    return r.result?.value || r.value || { x: 0, y: 0, w: 1280, h: 800 };
  } catch { return { x: 0, y: 0, w: 1280, h: 800 }; }
}
async function visibleMap(sessionId, backends, rect) {
  const map = new Map();
  await Promise.all([...new Set(backends)].map(async (b) => {
    try {
      const r = await cdpCall("DOM.getBoxModel", { backendNodeId: b }, sessionId);
      const c = r.model?.content; if (!c || c.length < 8) { map.set(b, false); return; }
      const x1 = Math.min(c[0], c[2], c[4], c[6]), x2 = Math.max(c[0], c[2], c[4], c[6]);
      const y1 = Math.min(c[1], c[3], c[5], c[7]), y2 = Math.max(c[1], c[3], c[5], c[7]);
      map.set(b, x2 >= rect.x && x1 <= rect.x + rect.w && y2 >= rect.y && y1 <= rect.y + rect.h);
    } catch { map.set(b, false); }
  }));
  return map;
}

function renderAX(nodes, opts, refs, lines, frameId, baseDepth, visMap) {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const childSet = new Set(nodes.flatMap(n => n.childIds || []));
  const roots = nodes.filter(n => !childSet.has(n.nodeId));
  const walk = (node, depth, inSub) => {
    if (node.ignored || SKIP_ROLES.has(node.role?.value)) {
      for (const cid of node.childIds || []) { const c = byId.get(cid); if (c) walk(c, depth, inSub); }
      return;
    }
    const role = node.role?.value || "generic";
    if (SKIP_ROLES.has(role)) { for (const cid of node.childIds || []) { const c = byId.get(cid); if (c) walk(c, depth, inSub); } return; }
    const name = node.name?.value || "";
    const backend = node.backendDOMNodeId;
    const subtreeHit = !opts.root || inSub || backend === opts.root;
    const visible = !visMap || !backend || visMap.get(backend) !== false;
    const keep = (!opts.interactiveOnly || INTERACTIVE.has(role) || role === "generic" || role === "none" || role === "RootWebArea");
    if (subtreeHit && keep && visible) {
      if (backend) {
        let loc; if (INTERACTIVE.has(role) && name) loc = `${role}:${role}[name=${JSON.stringify(name)}]`;
        refs.push({ backendNodeId: backend, role, name, ...(loc ? { loc } : {}), ...(frameId ? { frameId, frameProvenance: "frame" } : {}) });
        lines.push(`${"  ".repeat(depth)}${role}${name ? ` "${name.replace(/"/g, '\\"')}"` : ""} [ref=${backend}${loc ? `, loc=${loc}` : ""}]`);
      } else if (name || role !== "generic") {
        lines.push(`${"  ".repeat(depth)}${role}${name ? ` "${name.replace(/"/g, '\\"')}"` : ""}`);
      }
    }
    for (const cid of node.childIds || []) { const c = byId.get(cid); if (c) walk(c, depth + 1, inSub || backend === opts.root); }
  };
  if (opts.root && !frameId) {
    const rn = nodes.find(n => n.backendDOMNodeId === Number(opts.root) || n.backendDOMNodeId === opts.root);
    if (rn) { walk(rn, baseDepth, true); return; }
  }
  for (const r of roots) walk(r, baseDepth, false);
}

const TAG_ROLE = { BUTTON: "button", A: "link", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading", P: "paragraph", LI: "listitem", IMG: "img", IFRAME: "Iframe" };
function domText(node) {
  if (node.nodeType === 3) return node.nodeValue || "";
  return (node.children || []).map(domText).join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
}
function walkDOM(docNode, depth, refs, lines, frameId, visMap, opts) {
  const visit = (n) => {
    if (!n) return;
    if (n.nodeType === 1) {
      const tag = n.nodeName;
      const role = TAG_ROLE[tag];
      const attrs = {}; (n.attributes || []).reduce((a, v, i, arr) => { if (i % 2 === 0) a[v] = arr[i + 1]; return a; }, attrs);
      const name = (attrs["aria-label"] || attrs.placeholder || attrs.alt || domText(n) || "").trim();
      const backend = n.backendNodeId;
      const visible = !visMap || !backend || visMap.get(backend) !== false;
      if (role && backend && visible && (!opts.interactiveOnly || INTERACTIVE.has(role) || role === "heading" || role === "paragraph")) {
        let loc; if (INTERACTIVE.has(role) && name && !name.includes("]")) loc = `${role}:${role}[name=${JSON.stringify(name)}]`;
        refs.push({ backendNodeId: backend, role, name, ...(loc ? { loc } : {}), ...(frameId ? { frameId, frameProvenance: "frame" } : {}) });
        lines.push(`${"  ".repeat(depth)}${role}${name ? ` "${name.replace(/"/g, '\\"')}"` : ""} [ref=${backend}${loc ? `, loc=${loc}` : ""}]`);
      }
      if (n.contentDocument) {
        lines.push(`${"  ".repeat(depth + 1)}Iframe [ref=${backend || 0}]`);
        walkDOM(n.contentDocument, depth + 2, refs, lines, n.frameId || frameId, visMap, opts);
        return;
      }
    }
    for (const c of n.children || []) visit(c);
    if (n.contentDocument) walkDOM(n.contentDocument, depth + 1, refs, lines, n.frameId || frameId, visMap, opts);
  };
  visit(docNode);
}

async function snapshotImpl(options = {}) {
  const task = tasks.get(selected);
  if (!task) throw err("EGO_TASK_SPACE_NOT_SELECTED", "Task space not selected");
  if (task.userControl) throw err("EGO_TASK_SPACE_USER_IN_CONTROL", "manual_takeover");
  const tab = await ensureTab(task);
  const sessionId = await attach(tab.targetId);
  const opts = { scope: options.scope || "full_page", root: options.root, interactiveOnly: !!options.interactiveOnly, maxResultLength: options.maxResultLength };
  let visMap = null;
  if (opts.scope === "only_within_viewport") {
    const rect = await viewportRect(sessionId);
    // visibleMap computed after collecting backends below via a first pass: use AX backends
    visMap = new Map(); // filled lazily in second pass
    opts._rect = rect;
  }
  await cdpCall("Accessibility.enable", {}, sessionId).catch(() => {});
  const { nodes } = await cdpCall("Accessibility.getFullAXTree", {}, sessionId);
  const refs = []; const lines = ["root"];
  renderAX(nodes, opts, refs, lines, null, 1, null);
  // Iframe content: DOM pierce (same-process) + OOPIF targets (cross-process)
  let domDoc = null;
  try { domDoc = (await cdpCall("DOM.enable", {}, sessionId).catch(() => {}), await cdpCall("DOM.getDocument", { depth: -1, pierce: true }, sessionId)).root; } catch {}
  const hasIframeNode = refs.some(r => r.role === "Iframe");
  if (domDoc && hasIframeNode) {
    // collect iframe backend ids from DOM to build visibility / walk content docs
    const iframeBackends = [];
    const collect = (n) => { if (!n) return; if (n.nodeType === 1 && n.nodeName === "IFRAME" && n.contentDocument) iframeBackends.push(n); for (const c of n.children || []) collect(c); };
    collect(domDoc);
    for (const ifr of iframeBackends) {
      lines.push(`  Iframe [ref=${ifr.backendNodeId || 0}]`);
      walkDOM(ifr.contentDocument, 2, refs, lines, ifr.frameId, null, opts);
    }
  }
  try {
    const { targetInfos } = await cdpCall("Target.getTargets");
    for (const ti of targetInfos.filter(t => t.type === "iframe")) {
      try {
        const sid = await attach(ti.targetId);
        await cdpCall("Accessibility.enable", {}, sid).catch(() => {});
        const t = await cdpCall("Accessibility.getFullAXTree", {}, sid);
        if (t.nodes?.length) renderAX(t.nodes, opts, refs, lines, ti.targetId, 2, null);
      } catch {}
    }
  } catch {}
  // Stable locators: upgrade role locs to CSS locs from DOM attributes (id / data-testid / name).
  // Native includeStableLocator does this in the fork; we approximate via DOM.getDocument attrs.
  if (domDoc && options.includeStableLocator !== false) {
    const attrMap = new Map();
    const collectAttrs = (n) => { if (!n) return; if (n.nodeType === 1 && n.backendNodeId) { const a = {}; (n.attributes || []).reduce((o, v, i, arr) => { if (i % 2 === 0) o[v] = arr[i + 1]; return o; }, a); attrMap.set(n.backendNodeId, a); } for (const c of n.children || []) collectAttrs(c); if (n.contentDocument) collectAttrs(n.contentDocument); };
    collectAttrs(domDoc);
    const escCss = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
    for (const r of refs) {
      const a = attrMap.get(r.backendNodeId); if (!a) continue;
      let css = null;
      if (a.id) css = `#${escCss(a.id)}`;
      else if (a["data-testid"]) css = `[data-testid="${a["data-testid"]}"]`;
      else if (a.name && INTERACTIVE.has(r.role)) css = `[name="${a.name}"]`;
      if (css) { r.loc = `css:${css}`; }
    }
    // Rewrite loc in content lines to match (validator in page.snapshot uses refs, content is for agents)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/\[ref=(\d+)/);
      if (!m) continue;
      const r = refs.find(x => x.backendNodeId === Number(m[1]));
      if (r?.loc) lines[i] = lines[i].replace(/\[ref=.*\]$/, `[ref=${r.backendNodeId}, loc=${r.loc}]`);
    }
  }
  // Viewport filter: drop refs/lines whose backend is offscreen (best-effort).
  if (opts.scope === "only_within_viewport" && opts._rect) {
    const allBackends = refs.map(r => r.backendNodeId);
    const vm = await visibleMap(sessionId, allBackends, opts._rect);
    const off = new Set([...vm.entries()].filter(([, v]) => v === false).map(([k]) => k));
    if (off.size) {
      for (let i = refs.length - 1; i >= 0; i--) if (off.has(refs[i].backendNodeId)) refs.splice(i, 1);
      // Rebuild content without offscreen ref lines (keep structure lines)
      const keepLines = lines.filter(l => ![...off].some(b => l.includes(`[ref=${b}`) || l.includes(`[ref=${b},`)));
      lines.length = 0; lines.push(...keepLines);
    }
  }
  let content = lines.join("\n");
  if (opts.maxResultLength) content = content.slice(0, opts.maxResultLength);
  return { content, refs };
}

const ego = {
  onCDPMessage: null, onSendCDPMessageError: null,
  sendCDPMessage(msg) {
    if (ws.readyState !== WebSocket.OPEN) { ego.onSendCDPMessageError?.("CDP channel unavailable", "EGO_CDP_CHANNEL_UNAVAILABLE"); return; }
    try { const m = JSON.parse(msg); if (m.method === "Target.activateTarget" && m.params?.targetId) { const t = tasks.get(selected); if (t) t.activatedTargetId = m.params.targetId; } } catch {}
    ws.send(msg);
  },
  async getBrowserVersion() { try { const v = await cdpCall("Browser.getVersion"); return { currentVersion: (v.product || "Chromium").replace(/^HeadlessChrome\//, "").replace(/^Chrome\//, "") || "Chromium", updateAvailable: false }; } catch { return { currentVersion: "Chromium", updateAvailable: false }; } },
  async listProfiles() {
    const seen = new Map([["Default", { id: "Default", name: "Personal", isDefault: true }]]);
    for (const base of [join(homedir(), ".config/google-chrome"), join(homedir(), ".config/chromium")]) {
      try { for (const d of (await import("node:fs")).readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
        if ((d === "Default" || d.startsWith("Profile ")) && !seen.has(d)) seen.set(d, { id: d, name: d === "Default" ? "Personal" : d, isDefault: false });
      } } catch {}
    }
    return { profiles: [...seen.values()] };
  },
  useTaskSpace(id) {
    if (typeof id !== "number" || arguments.length !== 1) throw Object.assign(new TypeError("useTaskSpace(id: number)"), { error_code: "EGO_INVALID_ARGUMENT" });
    selected = id; return id;
  },
  async listTaskSpaces() {
    const out = [];
    for (const t of tasks.values()) {
      let titles = []; try { titles = (await taskTabs(t)).map(x => x.title).filter(Boolean); } catch {}
      out.push({ id: t.id, taskId: t.name, name: t.name, createdBy: "agent", ownership: t.userControl ? "user" : "agent", profileId: "Default", profileName: "Personal", recentTabTitles: titles, ...(t.lastError ? { lastError: t.lastError } : {}) });
    }
    return { taskSpaces: out };
  },
  async createTaskSpace(name, profileId) {
    if (typeof name !== "string" || !name) throw Object.assign(new TypeError("name required"), { error_code: "EGO_INVALID_ARGUMENT" });
    if (profileId && profileId !== "default") {
      const { profiles } = await ego.listProfiles();
      if (!profiles.some(p => p.id === profileId)) return { error: "Profile not found", error_code: "EGO_PROFILE_NOT_FOUND" };
    }
    const { browserContextId } = await cdpCall("Target.createBrowserContext", {});
    const id = nextTask++;
    tasks.set(id, { id, name, browserContextId, userControl: false });
    await cdpCall("Target.createTarget", { url: "about:blank", browserContextId }).catch(() => {});
    return { id, taskId: name, name };
  },
  async claimTaskSpace(id, name) {
    const t = tasks.get(id); if (!t) return { error: `Task space not found: ${id}`, error_code: "EGO_TASK_SPACE_NOT_FOUND" };
    if (name) t.name = name; t.userControl = false; return { id: t.id, taskId: t.name, name: t.name };
  },
  async markTaskSpaceError(message) {
    const t = tasks.get(selected); if (!t) return { error: "Task space not found", error_code: "EGO_TASK_SPACE_NOT_FOUND" };
    if (typeof message !== "string") throw Object.assign(new TypeError("ego.markTaskSpaceError(message) expects a string error message."), { error_code: "EGO_INVALID_ARGUMENT" });
    t.lastError = message; return `${selected} task space error marked.`;
  },
  async deleteSpaces(options) {
    const ids = options?.ids;
    const scope = options?.scope;
    const targets = [];
    if (Array.isArray(ids)) targets.push(...ids);
    else if (scope === "all") targets.push(...tasks.keys());
    else if (scope === "task") { if (selected != null) targets.push(selected); }
    else return { error: "ego.deleteSpaces(options) expects {scope: 'all'|'task'} or {ids: number[]} options.", error_code: "EGO_INVALID_ARGUMENT" };
    for (const id of targets) { const t = tasks.get(id); if (t) { await cdpCall("Target.disposeBrowserContext", { browserContextId: t.browserContextId }).catch(() => {}); tasks.delete(id); if (selected === id) selected = null; } }
    return `${targets.length} task space(s) deleted.`;
  },
  async closeTaskSpace() { const t = tasks.get(selected); if (!t) return { error: "Task space not found", error_code: "EGO_TASK_SPACE_NOT_FOUND" }; await cdpCall("Target.disposeBrowserContext", { browserContextId: t.browserContextId }).catch(() => {}); tasks.delete(selected); return `${selected} task space closed.`; },
  async completeTaskSpace() { const t = tasks.get(selected); if (!t) return { error: "Task space not found", error_code: "EGO_TASK_SPACE_NOT_FOUND" }; t.userControl = true; return `${selected} task space completed.`; },
  async handOffTaskSpace() { const t = tasks.get(selected); if (t) t.userControl = true; return `${selected} has been handed off to the user.`; },
  async takeOverTaskSpace() { const t = tasks.get(selected); if (t) t.userControl = false; return `${selected} has been taken over by the agent.`; },
  async setAgentTaskState(state) {
    try {
      const t = tasks.get(selected); if (t) { const tab = await ensureTab(t); const sid = await attach(tab.targetId);
        await cdpCall("Runtime.evaluate", { expression: `document.getElementById('ego-linux-state')?.remove(); (function(s){var d=document.createElement('div'); d.id='ego-linux-state'; d.style.cssText='position:fixed;top:8px;left:8px;z-index:2147483647;background:#111;color:#fff;font:12px system-ui;padding:4px 8px;border-radius:4px;opacity:.9;pointer-events:none'; d.textContent='ego: '+s; d.setAttribute('aria-hidden','true'); document.body.appendChild(d);})(${JSON.stringify(String(state ?? ""))})`, returnByValue: true }, sid).catch(() => {});
      }
    } catch {}
    return `${selected} state updated.`;
  },
  async showAgentGesture(cmd) {
    // Native (RE-found): ego.showAgentGesture({type:'point'|'press'|'scroll'|'write'|'key'|'think'|'outcome', ...})
    const types = ["point", "press", "scroll", "write", "key", "think", "outcome"];
    if (!cmd || typeof cmd !== "object" || !types.includes(cmd.type)) throw Object.assign(new TypeError("ego.showAgentGesture(command) expects { type: 'point', x, y }, { type: 'press', x?, y? }, { type: 'scroll', deltaX?, deltaY?, x?, y? }, { type: 'write', chars? }, { type: 'key' }, { type: 'think', label } or { type: 'outcome', ok }, with finite numbers and x and y given together."), { error_code: "EGO_INVALID_ARGUMENT" });
    try {
      const t = tasks.get(selected); if (t) { const tab = await ensureTab(t); const sid = await attach(tab.targetId);
        const x = Number(cmd.x) || 100, y = Number(cmd.y) || 100;
        const label = cmd.label || cmd.chars || cmd.key || (cmd.type === "outcome" ? (cmd.ok ? "✓ done" : "✗ failed") : cmd.type);
        await cdpCall("Runtime.evaluate", { expression: `(function(x,y,label){var d=document.createElement('div'); d.setAttribute('aria-hidden','true'); d.style.cssText='position:fixed;left:'+(x-12)+'px;top:'+(y-12)+'px;min-width:24px;height:24px;border:3px solid #4f8cff;border-radius:50%;background:rgba(79,140,255,.25);color:#fff;font:11px system-ui;padding:2px 6px;z-index:2147483647;pointer-events:none'; d.textContent=label; document.body.appendChild(d); setTimeout(function(){d.remove()},1600); return 1;})(${x},${y},${JSON.stringify(String(label))})`, returnByValue: true }, sid).catch(() => {});
      }
    } catch {}
    return `${selected} agent gesture shown.`;
  },
  async animationHighlightMouseToPosition(x, y) {
    try {
      const t = tasks.get(selected); if (t) { const tab = await ensureTab(t); const sid = await attach(tab.targetId);
        await cdpCall("Runtime.evaluate", { expression: `(function(x,y){var d=document.createElement('div'); d.style.cssText='position:fixed;left:'+(x-14)+'px;top:'+(y-14)+'px;width:28px;height:28px;border:3px solid #e33;border-radius:50%;z-index:2147483647;pointer-events:none;transition:all .3s'; d.setAttribute('aria-hidden','true'); document.body.appendChild(d); setTimeout(function(){d.style.transform='scale(1.6)'; d.style.opacity='0';},50); setTimeout(function(){d.remove();},1300); return 1;})(${Number(x)||0},${Number(y)||0})`, returnByValue: true }, sid).catch(() => {});
      }
    } catch {}
    return `${selected} mouse highlight shown.`;
  },
  async createTab(url) {
    const t = tasks.get(selected);
    if (!t) return { error: "Task space not selected", error_code: "EGO_TASK_SPACE_NOT_SELECTED" };
    if (t.userControl) return { error: "manual_takeover", error_code: "EGO_TASK_SPACE_USER_IN_CONTROL" };
    const { targetId } = await cdpCall("Target.createTarget", { url: String(url), browserContextId: t.browserContextId });
    t.activatedTargetId = targetId;
    return { targetId };
  },
  async listTabs() {
    const t = tasks.get(selected);
    if (!t) return { error: "Task space not selected", error_code: "EGO_TASK_SPACE_NOT_SELECTED" };
    if (t.userControl) return { error: "manual_takeover", error_code: "EGO_TASK_SPACE_USER_IN_CONTROL" };
    const tabs = await taskTabs(t);
    return { tabs: tabs.map((tab, i) => ({ index: i, targetId: tab.targetId, url: tab.url, title: tab.title, active: t.activatedTargetId ? tab.targetId === t.activatedTargetId : i === tabs.length - 1 })) };
  },
  async snapshot(options) { return snapshotImpl(options || {}); },
};
globalThis.ego = ego;

const bundle = await loadBundle();
if (SERVE) {
  mkdirSync(DAEMON_DIR, { recursive: true });
  try { rmSync(DAEMON_SOCK, { force: true }); } catch {}
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.on("error", () => {});
    let buf = ""; sock.setEncoding("utf8");
    sock.on("data", async (d) => {
      buf += d;
      const idx = buf.indexOf("\n\x00END\x00\n");
      if (idx < 0) return;
      const code = buf.slice(0, idx);
      if (code.trim() === "__STOP__") { sock.end("daemon stopped\n"); setTimeout(() => { kill(); try { rmSync(DAEMON_SOCK, { force: true }); } catch {} process.exit(0); }, 100); return; }
      let out = "", errOut = "";
      const stdout = { write: (c) => { out += c; return true; } };
      const stderr = { write: (c) => { errOut += c; return true; } };
      let exitCode = 0;
      try { exitCode = await bundle.runMain({ argv: [], stdinText: code, stdout, stderr }) || 0; }
      catch (e) { exitCode = 1; errOut += (e?.stack || String(e)) + "\n"; }
      sock.end(out + (errOut ? errOut : "") + `\n__EXIT__:${exitCode}\n`);
    });
  });
  server.listen(DAEMON_SOCK, () => console.error(`ego-linux daemon listening on ${DAEMON_SOCK}`));
  process.on("SIGTERM", () => { kill(); process.exit(0); });
  // Crash recovery: if Chromium dies, exit the daemon so the next run respawns fresh.
  if (child) child.on("exit", (code) => { if (!ATTACH_URL) { console.error(`ego-linux: browser exited (${code}), daemon shutting down for clean restart`); rmSync(DAEMON_SOCK, { force: true }); process.exit(1); } });
  // --- GUI: local web dashboard ("ego home" equivalent), served by the daemon ---
  const GUI_PORT = Number(process.env.EGO_LINUX_GUI_PORT || "8765");
  const http = await import("node:http");
  const guiHtml = `<!doctype html><html><head><meta charset="utf-8"><title>ego home (linux)</title><style>body{font:14px system-ui;background:#0f1115;color:#e6e6e6;margin:0;display:flex;flex-direction:column;height:100vh}#mainland{height:44px;background:#171a21;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid #222}#wrap{flex:1;display:flex;min-height:0}#strip{width:64px;background:#171a21;border-right:1px solid #222;display:flex;flex-direction:column;align-items:center;padding:8px 0;gap:6px;overflow:auto}.island{width:44px;height:44px;border-radius:50%;background:#22262f;display:flex;align-items:center;justify-content:center;cursor:pointer;font-weight:700}.island.on{background:#2f5fd0;box-shadow:0 0 0 2px #4f8cff}.island small{display:block;font-size:9px;opacity:.6}main{flex:1;display:flex;flex-direction:column;padding:12px;gap:8px;overflow:auto}button{background:#2f5fd0;color:#fff;border:0;padding:6px 10px;border-radius:6px;cursor:pointer;margin:2px}button.ghost{background:#333a47}input{background:#22262f;color:#e6e6e6;border:1px solid #333;padding:6px;border-radius:6px}pre{background:#0a0c10;padding:10px;border-radius:8px;white-space:pre-wrap;max-height:38vh;overflow:auto}img{max-width:100%;border-radius:8px;border:1px solid #333}.ring{border:2px solid #4f8cff;border-radius:50%;padding:2px 8px}</style></head><body><div id=mainland><b>ego home</b><span class=ring>linux</span><input id=url placeholder="https://…" size=42><button onclick="nav()">Go</button><button class=ghost onclick="snap()">Snapshot</button><button class=ghost onclick="act('handoff')">Hand off</button><button class=ghost onclick="act('takeover')">Take over</button><button class=ghost onclick="act('finish')">Finish</button><button class=ghost onclick="act('close')">Close</button></div><div id=wrap><div id=strip></div><main><div id=info></div><img id=shot alt="screenshot"><pre id=out></pre><div><input id=newname placeholder="space name"><button onclick="createSpace()">+ New Space (island)</button><span style="opacity:.6">Headed: EGO_LINUX_HEADLESS=0 · Attach: EGO_LINUX_CDP_URL=…</span></div></main></div><script>let cur=null;async function api(p,o){let r=await fetch(p,o);return r.json()}async function load(){let d=await api('/api/spaces');strip.innerHTML=d.taskSpaces.map(s=>'<div class="island '+(s.id===cur?'on':'')+'" onclick="sel('+s.id+')" title="'+s.name+'">'+s.name.slice(0,2).toUpperCase()+'</div>').join('')+'<div class="island" onclick="createSpace()">+</div>';info.textContent=d.taskSpaces.filter(s=>s.id===cur).map(s=>s.name+' #'+s.id+' · '+s.ownership+(s.lastError?' · ⚠ '+s.lastError:'')+' · '+(s.recentTabTitles||[]).join(', ')).join('');if(cur!=null)shot.src='/api/screenshot?id='+cur+'&t='+Date.now()}async function sel(id){cur=id;await api('/api/select',{method:'POST',body:JSON.stringify({id})});load();snap()}async function createSpace(){let n=newname.value||('space-'+Date.now()%10000);let d=await api('/api/space',{method:'POST',body:JSON.stringify({name:n})});cur=d.id;load();snap()}async function nav(){await api('/api/navigate',{method:'POST',body:JSON.stringify({id:cur,url:url.value})});load();snap()}async function snap(){if(cur==null)return;let d=await api('/api/snapshot?id='+cur);out.textContent=d.content||JSON.stringify(d);load()}async function act(a){await api('/api/'+a,{method:'POST',body:JSON.stringify({id:cur})});load();snap()}load();setInterval(()=>{if(cur!=null)shot.src='/api/screenshot?id='+cur+'&t='+Date.now()},3000)</script></body></html>`;
  const json = (res, obj) => { res.writeHead(200, {"content-type": "application/json"}); res.end(JSON.stringify(obj)); };
  const body = async (req) => { let b = ""; for await (const c of req) b += c; return b ? JSON.parse(b) : {}; };
  http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/") { res.writeHead(200, {"content-type": "text/html"}); res.end(guiHtml); return; }
      if (u.pathname === "/api/spaces") { json(res, await ego.listTaskSpaces()); return; }
      if (u.pathname === "/api/select" && req.method === "POST") { const b = await body(req); ego.useTaskSpace(b.id); selected = b.id; json(res, { ok: true }); return; }
      if (u.pathname === "/api/space" && req.method === "POST") { const b = await body(req); const t = await ego.createTaskSpace(b.name || "space"); ego.useTaskSpace(t.id); json(res, t); return; }
      const id = Number(u.searchParams.get("id"));
      if (id) { const prev = selected; ego.useTaskSpace(id); }
      if (u.pathname === "/api/snapshot") { const s = await snapshotImpl({ scope: "full_page" }); json(res, s); return; }
      if (u.pathname === "/api/screenshot") {
        const t = tasks.get(selected); const tab = await ensureTab(t); const sid = await attach(tab.targetId);
        const shotRes = await cdpCall("Page.captureScreenshot", { format: "png" }, sid);
        res.writeHead(200, {"content-type": "image/png"}); res.end(Buffer.from(shotRes.data, "base64")); return;
      }
      if (u.pathname === "/api/navigate" && req.method === "POST") { const b = await body(req); const t = tasks.get(selected); const tab = await ensureTab(t); const sid = await attach(tab.targetId); await cdpCall("Page.navigate", { url: b.url }, sid); json(res, { ok: true }); return; }
      if (u.pathname === "/api/handoff") { json(res, { r: await ego.handOffTaskSpace() }); return; }
      if (u.pathname === "/api/takeover") { json(res, { r: await ego.takeOverTaskSpace() }); return; }
      if (u.pathname === "/api/finish") { json(res, { r: await ego.completeTaskSpace() }); return; }
      if (u.pathname === "/api/close") { json(res, { r: await ego.closeTaskSpace() }); return; }
      res.writeHead(404); res.end("not found");
    } catch (e) { res.writeHead(500, {"content-type": "application/json"}); res.end(JSON.stringify({ error: String(e?.message || e) })); }
  }).listen(GUI_PORT, "127.0.0.1", () => console.error(`ego-linux GUI: http://127.0.0.1:${GUI_PORT}/`));
} else {
  try {
    const code = CLI_CODE ?? readFileSync(0, "utf8");
    await bundle.runMain({ argv: [], stdinText: code });
  } finally { kill(); try { ws.close(); } catch {} setTimeout(() => process.exit(process.exitCode || 0), 200); }
}
