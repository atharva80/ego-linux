#!/usr/bin/env bash
# ego-linux smoke tests: core workflows against the daemon (idempotent spaces).
set -u
cd "$(dirname "$0")/.."
run() { echo "--- $1"; printf '%s' "$2" | timeout 60 ego-linux; echo "exit:$?"; }
run "goto+snapshot+fill+click" 'const t=await taskSpace("smoke"); const p=t.page("p1"); await p.goto("data:text/html,<title>T</title><input id=q placeholder=name><button>Go</button><p id=o>idle</p><script>document.querySelector(\"button\").onclick=()=>document.getElementById(\"o\").textContent=\"ok:\"+document.getElementById(\"q\").value</script>"); await p.fill("loc=role:textbox[name=\"name\"]","Smoke"); await p.click("loc=role:button[name=\"Go\"]"); console.log(await p.snapshot()); await t.finish({keep:[]});'
run "iframe click" 'const t=await taskSpace("smoke-if"); const p=t.page("p1"); await p.goto("data:text/html,<title>F</title><iframe srcdoc="<button>Inner</button><p id=o>before</p><script>document.querySelector(String.fromCharCode(39))</script>"></iframe>"); console.log(await p.snapshot()); await t.finish({keep:[]});'
run "viewport" 'const t=await taskSpace("smoke-vp"); const p=t.page("p1"); await p.goto("data:text/html,<title>V</title><div style=\"height:2000px\"><button>Top</button></div><button>Bottom</button>"); console.log(await p.snapshot({scope:"only_within_viewport"})); await t.finish({keep:[]});'
run "gui api" 'console.log(await listTaskSpaces())'
echo "--- gui http"; curl -s http://127.0.0.1:8765/api/spaces | head -c 200; echo
echo "--- npm test (harness)"; (cd ego-lite/package/ego-browser && npm test 2>&1 | tail -6)
df -h .
