#!/usr/bin/env python3
"""ego-linux native GUI — mainland chrome + islands (Spaces) + shelf (tabs),
modeled on the fork's ego/browser/ui/mainland/* and views/frame/*
(agent_mouse_layer_view, task_status_ring_view, ai_chat_view).
Talks to the daemon GUI API (:8765). Screenshot polling = browser view;
in-page agent overlays (showAgentGesture/setAgentTaskState) appear in it.
"""
import json, sys, urllib.request, urllib.error
from PySide6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout,
    QHBoxLayout, QLineEdit, QPushButton, QLabel, QTextEdit, QTabBar, QDialog,
    QDialogButtonBox)
from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import QPixmap, QPainter, QPen, QColor, QImage

API = "http://127.0.0.1:8765"
def api(path, data=None):
    req = urllib.request.Request(API + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read() or b"{}")
    except Exception as e: return {"error": str(e)}

class ShotLabel(QLabel):
    def __init__(self): super().__init__(); self._pix = None; self.ring = None
    def setPixmap(self, p): self._pix = p; super().setPixmap(p)
    def paintEvent(self, e):
        super().paintEvent(e)
        if self.ring:
            q = QPainter(self); q.setPen(QPen(QColor("#4f8cff"), 3)); q.drawEllipse(self.ring[0]-14, self.ring[1]-14, 28, 28); q.end()

class Main(QMainWindow):
    def __init__(self):
        super().__init__(); self.setWindowTitle("ego linux — ego home"); self.resize(1280, 800); self.cur = None
        central = QWidget(); self.setCentralWidget(central)
        root = QVBoxLayout(central); root.setContentsMargins(0, 0, 0, 0)
        # mainland bar
        bar = QHBoxLayout()
        bar.addWidget(QLabel("<b>ego home</b> <font color='#4f8cff'>● linux</font>"))
        self.url = QLineEdit(); self.url.setPlaceholderText("https://…"); self.url.setMinimumWidth(280); bar.addWidget(self.url)
        for txt, fn in [("Go", self.nav), ("Snapshot", self.snap), ("Hand off", lambda: self.act("handoff")),
                        ("Take over", lambda: self.act("takeover")), ("Finish", lambda: self.act("finish")),
                        ("Close", lambda: self.act("close"))]:
            b = QPushButton(txt); b.clicked.connect(fn); bar.addWidget(b)
        root.addLayout(bar)
        wrap = QHBoxLayout(); root.addLayout(wrap, 1)
        # island strip (vertical)
        self.strip = QVBoxLayout(); w = QWidget(); w.setLayout(self.strip); w.setMaximumWidth(72); wrap.addWidget(w)
        # shelf + browser view + side panel
        mid = QVBoxLayout(); wrap.addLayout(mid, 1)
        self.tabs = QTabBar(); self.tabs.currentChanged.connect(self.tab_clicked); mid.addWidget(self.tabs)
        self.info = QLabel("No Space selected — create one (+)"); mid.addWidget(self.info)
        self.shot = ShotLabel(); self.shot.setAlignment(Qt.AlignTop); mid.addWidget(self.shot, 1)
        self.out = QTextEdit(); self.out.setReadOnly(True); self.out.setMaximumHeight(180); mid.addWidget(self.out)
        # AI side panel (ai_chat_view equivalent)
        side = QVBoxLayout(); w2 = QWidget(); w2.setLayout(side); w2.setMaximumWidth(300); wrap.addWidget(w2)
        side.addWidget(QLabel("<b>Ask ego</b> (ai_chat_view)"))
        self.goal = QLineEdit(); self.goal.setPlaceholderText("open a site…"); side.addWidget(self.goal)
        run = QPushButton("Run"); run.clicked.connect(self.chat); side.addWidget(run)
        nb = QPushButton("+ New Space"); nb.clicked.connect(self.create_space); side.addWidget(nb)
        ob = QPushButton("Onboarding / Import Chrome"); ob.clicked.connect(self.onboard); side.addWidget(ob)
        self.timer = QTimer(self); self.timer.timeout.connect(self.refresh); self.timer.start(3000)
        self.refresh()
    def refresh(self):
        d = api("/api/spaces")
        for i in reversed(range(self.strip.count())):
            it = self.strip.takeAt(i); it.widget().deleteLater() if it.widget() else None
        for s in d.get("taskSpaces", []):
            b = QPushButton(s["name"][:2].upper()); b.setCheckable(True); b.setChecked(s["id"] == self.cur)
            b.setToolTip(f"{s['name']} #{s['id']} · {s['ownership']}" + (f" · ⚠ {s['lastError']}" if s.get("lastError") else ""))
            b.clicked.connect(lambda _, i=s["id"]: self.sel(i)); self.strip.addWidget(b)
        plus = QPushButton("+"); plus.clicked.connect(self.create_space); self.strip.addWidget(plus)
        cur = [s for s in d.get("taskSpaces", []) if s["id"] == self.cur]
        self.info.setText(f"{cur[0]['name']} #{cur[0]['id']} · {cur[0]['ownership']}" + (f" · ⚠ {cur[0]['lastError']}" if cur and cur[0].get("lastError") else "") if cur else "No Space selected")
        if self.cur is not None:
            tb = api(f"/api/tabs?id={self.cur}")
            self.tabs.clear()
            for t in tb.get("tabs", []): self.tabs.addTab(t.get("title") or t.get("url") or "tab", t["targetId"])
            try:
                with urllib.request.urlopen(f"{API}/api/screenshot?id={self.cur}", timeout=10) as r:
                    data = r.read()
                if data: self.shot.setPixmap(QPixmap.fromImage(QImage.fromData(data)))
            except Exception: pass
    def sel(self, i): self.cur = i; api("/api/select", {"id": i}); self.refresh(); self.snap()
    def create_space(self):
        d = api("/api/space", {"name": "space"}); self.cur = d.get("id"); self.refresh(); self.snap()
    def nav(self): api("/api/navigate", {"id": self.cur, "url": self.url.text()}); self.refresh(); self.snap()
    def snap(self):
        if self.cur is None: return
        d = api(f"/api/snapshot?id={self.cur}"); self.out.setPlainText(d.get("content", json.dumps(d)))
    def act(self, a): api(f"/api/{a}", {"id": self.cur}); self.refresh(); self.snap()
    def tab_clicked(self, i):
        if i < 0: return
        tb = api(f"/api/tabs?id={self.cur}"); tabs = tb.get("tabs", [])
        if i < len(tabs): api("/api/activate", {"targetId": tabs[i]["targetId"]}); self.refresh(); self.snap()
    def chat(self):
        self.out.setPlainText("running…")
        d = api("/api/chat", {"goal": self.goal.text(), "space": "gui-chat"})
        self.out.setPlainText((d.get("out") or "") + (d.get("errOut") or ""))
    def onboard(self):
        dlg = QDialog(self); dlg.setWindowTitle("Onboarding")
        v = QVBoxLayout(dlg)
        v.addWidget(QLabel("1) Close Chrome.\n2) Run in a terminal:  ego-linux import-chrome\n3) Restart the daemon:  ego-linux stop\n\nYour logins, cookies and history carry over —\nsame as the Mac onboarding question."))
        bb = QDialogButtonBox(QDialogButtonBox.Ok); bb.accepted.connect(dlg.accept); v.addWidget(bb); dlg.exec()

if __name__ == "__main__":
    app = QApplication(sys.argv); w = Main(); w.show(); sys.exit(app.exec())
