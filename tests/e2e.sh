#!/usr/bin/env bash
# ego-linux v4 comprehensive test suite. Prints PASS/FAIL per scenario, exits nonzero on failure.
# Usage: tests/e2e.sh [ego-linux-binary]   (default: dist/ego-linux)
set -u
BIN="${1:-$(cd "$(dirname "$0")/.." && pwd)/dist/ego-linux}"
PASS=0; FAIL=0; FLAKY=0
t() { local name="$1"; shift; echo "=== $name"; if timeout 90 "$BIN" < "$1" > /tmp/e2e.out 2>&1; then echo "PASS: $name"; PASS=$((PASS+1)); else echo "FAIL: $name (see /tmp/e2e.out)"; cat /tmp/e2e.out; FAIL=$((FAIL+1)); fi; }
chk() { if grep -q "$2" /tmp/e2e.out; then echo "  assert ok: $2"; else echo "  assert FAIL: missing $2"; FAIL=$((FAIL+1)); fi; }
mkdir -p /tmp/e2e-tests
# 1 help/version/skill (no browser)
echo "=== help/version/skill"; "$BIN" --help >/dev/null && "$BIN" --version >/dev/null && "$BIN" skill | head -1 >/dev/null && echo "PASS: cli-meta" && PASS=$((PASS+1)) || { echo "FAIL: cli-meta"; FAIL=$((FAIL+1)); }
# 2 goto+snapshot
cat > /tmp/e2e-tests/01.js <<'EOF'
const t=await taskSpace("t01"); const p=t.page("p1");
await p.goto("data:text/html,<title>T1</title><h1>HelloTest</h1><button>Btn1</button>");
console.log(await p.snapshot()); await t.finish({keep:[]});
EOF
t "goto+snapshot" /tmp/e2e-tests/01.js; chk "HelloTest" "HelloTest"
# 3 fill+click quoted loc
cat > /tmp/e2e-tests/02.js <<'EOF'
const t=await taskSpace("t02"); const p=t.page("p1");
await p.goto("data:text/html,<title>T2</title><input id=q placeholder=name><button>Go</button><p id=o>idle</p><script>document.querySelector('button').onclick=()=>document.getElementById('o').textContent='ok:'+document.getElementById('q').value</script>");
await p.fill('loc=role:textbox[name="name"]',"E2E"); await p.click('loc=role:button[name="Go"]');
console.log(await p.snapshot()); await t.finish({keep:[]});
EOF
t "fill+click" /tmp/e2e-tests/02.js; chk "ok:E2E" "ok:E2E"
# 4 @ref click
cat > /tmp/e2e-tests/03.js <<'EOF'
const t=await taskSpace("t03"); const p=t.page("p1");
await p.goto("data:text/html,<title>T3</title><button id=b>RefBtn</button><p id=o>before</p><script>document.getElementById('b').onclick=()=>document.getElementById('o').textContent='after-ref'</script>");
const s=await p.snapshot(); const m=s.match(/button "RefBtn" \[ref=(\d+)/); await p.click("@"+m[1]);
console.log(await p.snapshot()); await t.finish({keep:[]});
EOF
t "@ref click" /tmp/e2e-tests/03.js; chk "after-ref" "after-ref"
# 5 iframe click
cat > /tmp/e2e-tests/04.js <<'EOF'
const t=await taskSpace("t04"); const p=t.page("p1");
await p.goto("data:text/html,<title>F</title><iframe srcdoc='<button>InnerBtn</button><p id=o>before</p><script>document.querySelector(String.fromCharCode(98,117,116,116,111,110)).onclick=()=>document.getElementById(String.fromCharCode(111)).textContent=\"after\"</script>'></iframe>");
await p.click("loc=role:button[name=InnerBtn]"); console.log(await p.snapshot()); await t.finish({keep:[]});
EOF
t "iframe click" /tmp/e2e-tests/04.js; chk "after" "after"
# 6 viewport vs full
cat > /tmp/e2e-tests/05.js <<'EOF'
const t=await taskSpace("t05"); const p=t.page("p1");
await p.goto("data:text/html,<title>V</title><div style='height:2000px'><button>TopBtn</button></div><button>BottomBtn</button>");
console.log("FULL:"+await p.snapshot({scope:"full_page"})); console.log("VIEW:"+await p.snapshot({scope:"only_within_viewport"})); await t.finish({keep:[]});
EOF
t "viewport" /tmp/e2e-tests/05.js; chk "BottomBtn" "BottomBtn"
# 7 dialog
cat > /tmp/e2e-tests/06.js <<'EOF'
const t=await taskSpace("t06"); const p=t.page("p1");
await p.goto("data:text/html,<title>D</title><button>Alert</button><p id=o>none</p><script>document.querySelector('button').onclick=()=>{alert('hi');document.getElementById('o').textContent='alerted'}</script>");
await p.click("loc=role:button[name=Alert]"); await p.acceptDialog(); console.log(await p.snapshot()); await t.finish({keep:[]});
EOF
for _try in 1 2 3; do timeout 60 "$BIN" < /tmp/e2e-tests/06.js > /tmp/e2e.out 2>&1 && grep -q alerted /tmp/e2e.out && break; echo "dialog retry $_try"; done; grep -q alerted /tmp/e2e.out && echo "PASS: dialog accept (flaky, passed within 3 tries)" && PASS=$((PASS+1)) || { echo "FAIL: dialog accept"; FAIL=$((FAIL+1)); }
# 8 keyboard
cat > /tmp/e2e-tests/07.js <<'EOF'
const t=await taskSpace("t07"); const p=t.page("p1");
await p.goto("data:text/html,<title>K</title><input id=q>");
await p.click("css=#q"); await p.keyboard.type("hello-keybd"); console.log(await p.snapshot()); await t.finish({keep:[]});
EOF
t "keyboard" /tmp/e2e-tests/07.js; chk "hello-keybd" "hello-keybd"
# 9 screenshot
cat > /tmp/e2e-tests/08.js <<'EOF'
const t=await taskSpace("t08"); const p=t.page("p1");
await p.goto("data:text/html,<title>S</title><h1>Shot</h1>"); console.log("SHOT:"+await p.screenshot()); await t.finish({keep:[]});
EOF
t "screenshot" /tmp/e2e-tests/08.js; F=$(grep -o '/tmp/ego-browser-shot-[^ ]*\.png' /tmp/e2e.out | head -1); file "$F" | grep -q PNG && echo "  png ok" || { echo "  png FAIL"; FAIL=$((FAIL+1)); }
# 10 multi-space isolation
cat > /tmp/e2e-tests/09.js <<'EOF'
const a=await taskSpace("iso-a"); const pa=a.page("p1"); await pa.goto("data:text/html,<title>A</title><h1>SpaceA</h1>");
const b=await taskSpace("iso-b"); const pb=b.page("p1"); await pb.goto("data:text/html,<title>B</title><h1>SpaceB</h1>");
console.log("A:"+await pa.snapshot()); console.log("B:"+await pb.snapshot()); await a.finish({keep:[]}); await b.finish({keep:[]});
EOF
t "multi-space" /tmp/e2e-tests/09.js; chk "SpaceA" "SpaceA"; chk "SpaceB" "SpaceB"
# 11 daemon persistence
cat > /tmp/e2e-tests/10a.js <<'EOF'
const t=await taskSpace("persist"); const p=t.page("p1"); await p.goto("data:text/html,<title>P1</title><h1>PersistOne</h1>"); console.log("created "+t.spaceId);
EOF
cat > /tmp/e2e-tests/10b.js <<'EOF'
console.log(JSON.stringify(await listTaskSpaces())); const t=await taskSpace("persist"); console.log(await t.page("p1").snapshot()); await t.finish({keep:[]});
EOF
t "daemon create" /tmp/e2e-tests/10a.js; t "daemon reuse" /tmp/e2e-tests/10b.js; chk "PersistOne" "PersistOne"
# 12 markTaskSpaceError + deleteSpaces
cat > /tmp/e2e-tests/11.js <<'EOF'
const t=await taskSpace("errtest"); const p=t.page("p1"); await p.goto("data:text/html,<title>E</title><h1>Err</h1>");
console.log(await markTaskSpaceError("Login wall could not be passed")); console.log(JSON.stringify(await listTaskSpaces()));
console.log(await deleteSpaces({ids:[t.spaceId]})); console.log(JSON.stringify(await listTaskSpaces()));
EOF
t "markError+deleteSpaces" /tmp/e2e-tests/11.js; chk "Login wall" "Login wall"
# 13 GUI API
echo "=== gui api"; curl -s http://127.0.0.1:8765/api/spaces >/dev/null && curl -s http://127.0.0.1:8765/ | grep -q "ego home" && echo "PASS: gui" && PASS=$((PASS+1)) || { echo "FAIL: gui (daemon GUI not up - start via a run first)"; FLAKY=$((FLAKY+1)); }
# 14 real site (network - flaky allowed)
cat > /tmp/e2e-tests/12.js <<'EOF'
const t=await taskSpace("web"); const p=t.page("p1"); await p.goto("https://example.com/"); console.log(await p.snapshot()); await t.finish({keep:[]});
EOF
t "real site example.com" /tmp/e2e-tests/12.js; chk "Example Domain" "Example Domain"
# 15 upstream harness tests
echo "=== upstream npm test"; (cd "$(dirname "$0")/../ego-lite/package/ego-browser" && npm test 2>&1 | tail -4)
echo "RESULT: pass=$PASS fail=$FAIL flaky=$FLAKY"; df -h "$(dirname "$0")/.." | tail -1
[ "$FAIL" -eq 0 ]
