# -*- coding: utf-8 -*-
"""Feature demo recorder for dsh-in-zotero.

Scenario = list of nodes; each node is (action, *args).
Actions:
  wait <seconds>
  bridge <op> [json]        POST http://127.0.0.1:23119/dsh-bridge/<op>
  click <x> <y>             physical-screen-pixel left click
  dblclick <x> <y>
  drag <x1> <y1> <x2> <y2>  slow human-ish drag select
  type <text>               unicode keystrokes
  key <vk>                  virtual-key tap (e.g. 13 = Enter)
  maxwin                    restore+maximize the Zotero window (DPI fix)
  closewin <title>          WM_CLOSE a window by exact title
  shot <name>               save a PNG frame
Run:
  python record_demo.py list
  python record_demo.py one <scene>        # record one scene -> rec/<scene>.mp4
  python record_demo.py all                # record every scene in SCENES
"""
import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request

import win32con
import win32gui

u = ctypes.windll.user32
u.SetProcessDPIAware()

FF = r"C:\Users\moqiq\miniforge3\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
TOKEN_FILE = None  # resolved lazily
BASE = "http://127.0.0.1:23119/dsh-bridge/"
OUT = r"C:\Users\moqiq\dshz-doc-work\rec"
SW, SH = 3840, 2160
FPS = 15

P_MOVE = 0x8000 | 1
P_LEFTDOWN, P_LEFTUP = 2, 4
KEYUP, UNI = 2, 0x1000


def token():
    global TOKEN_FILE
    if not TOKEN_FILE:
        import glob

        f = glob.glob(os.path.expandvars(r"%APPDATA%\Zotero\Zotero\Profiles\*\dsh-in-zotero\bridge-token"))
        TOKEN_FILE = f[0]
    return open(TOKEN_FILE).read().strip()


def bridge(op, payload=None):
    body = json.dumps(payload or {}).encode()
    req = urllib.request.Request(BASE + op, data=body, headers={
        "x-dsh-in-zotero-token": token(), "Content-Type": "application/json"})
    r = urllib.request.urlopen(req, timeout=180)
    out = json.load(r)
    print("    bridge", op, "->", json.dumps(out, ensure_ascii=False)[:160])
    return out


def mv(x, y):
    # injected mouse-move (not SetCursorPos): apps see a real input stream,
    # normalized against the CURRENT reported screen size (it drifts).
    u.mouse_event(P_MOVE, int(x * 65535 / (u.GetSystemMetrics(0) - 1)),
                  int(y * 65535 / (u.GetSystemMetrics(1) - 1)), 0, 0)


def click(x, y, delay=0.3):
    mv(x, y)
    time.sleep(delay)
    u.mouse_event(P_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.12)
    u.mouse_event(P_LEFTUP, 0, 0, 0, 0)


def drag(x1, y1, x2, y2):
    mv(x1, y1)
    time.sleep(0.4)
    u.mouse_event(P_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.3)
    steps = 45
    for i in range(1, steps + 1):
        mv(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
        time.sleep(0.025)
    time.sleep(0.35)
    u.mouse_event(P_LEFTUP, 0, 0, 0, 0)


def typestr(s):
    for ch in s:
        u.keybd_event(0, ord(ch), UNI, 0)
        u.keybd_event(0, ord(ch), UNI | KEYUP, 0)
        time.sleep(0.05)


def keytap(vk):
    u.keybd_event(vk, 0, 0, 0)
    u.keybd_event(vk, 0, KEYUP, 0)


def zotero_hwnd(title_substr="Zotero"):
    wins = []

    def cb(h, _):
        t = win32gui.GetWindowText(h)
        if win32gui.IsWindowVisible(h) and title_substr.lower() in t.lower() and win32gui.GetClassName(h) == "MozillaWindowClass":
            wins.append(h)

    win32gui.EnumWindows(cb, None)
    return wins[0] if wins else None


def maxwin():
    h = zotero_hwnd()
    win32gui.ShowWindow(h, win32con.SW_RESTORE)
    time.sleep(0.5)
    win32gui.ShowWindow(h, win32con.SW_MAXIMIZE)
    time.sleep(1.2)
    win32gui.SetForegroundWindow(h)
    time.sleep(0.3)


def closewin(title):
    h = win32gui.FindWindow(None, title)
    if h:
        win32gui.PostMessage(h, win32con.WM_CLOSE, 0, 0)
        time.sleep(1.0)


def shot(name):
    from PIL import ImageGrab

    img = ImageGrab.grab(all_screens=True)
    img.save(os.path.join(OUT, "frames", name + ".png"))
    print("    shot", name)


def wheel(x, y, delta):
    mv(x, y)
    time.sleep(0.4)
    u.mouse_event(0x0800, 0, 0, delta, 0)  # WHEEL


def waititem(item_id, max_seconds):
    """Poll until the item's title stops looking like a broken/file name."""
    deadline = time.time() + float(max_seconds)
    while time.time() < deadline:
        try:
            it = bridge("item", {"id": int(item_id)})
            title = (it.get("item", it).get("fields", {}) or {}).get("title", "")
            if title and ".pdf" not in title.lower() and len(title) > 12:
                print("    title restored:", title[:60])
                return
        except Exception as e:
            print("    poll error", e)
        time.sleep(3)
    print("    WARNING: item not restored in time")


ACTIONS = {
    "wait": lambda n: time.sleep(float(n)),
    "bridge": lambda op, payload=None: bridge(op, json.loads(payload) if payload else None),
    "click": lambda x, y: click(float(x), float(y)),
    "drag": lambda x1, y1, x2, y2: drag(float(x1), float(y1), float(x2), float(y2)),
    "type": typestr,
    "key": lambda vk: keytap(int(vk)),
    "maxwin": maxwin,
    "closewin": closewin,
    "shot": shot,
    "waititem": waititem,
    "wheel": lambda x, y, d: wheel(float(x), float(y), int(d)),
}


def run_nodes(nodes):
    for n in nodes:
        act, args = n[0], n[1:]
        print("  [%s] %s %s" % (time.strftime("%H:%M:%S"), act, " ".join(str(a) for a in args)))
        ACTIONS[act](*args)


def record(scene, nodes):
    os.makedirs(OUT, exist_ok=True)
    out_path = os.path.join(OUT, scene + ".mp4")
    cmd = [FF, "-y", "-f", "gdigrab", "-framerate", str(FPS), "-thread_queue_size", "512",
           "-i", "desktop", "-vf", "scale=1920:-2:flags=fast_bilinear",
           "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
           "-crf", "28", "-pix_fmt", "yuv420p", out_path]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("== recording", scene, "->", out_path)
    time.sleep(1.2)  # encoder warm-up
    try:
        maxwin()  # always ensure foreground + maximized before acting
        run_nodes(nodes)
    finally:
        time.sleep(0.8)
        try:
            proc.stdin.write(b"q")
            proc.stdin.flush()
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.terminate()
            proc.wait(timeout=10)
    size = os.path.getsize(out_path) / 1024
    print("== saved %s (%.0f KB)" % (out_path, size))


# ---------------------------------------------------------------------------
# Coordinates are for the 3840x2160 desktop, Zotero maximized, default layout.
# ---------------------------------------------------------------------------
SCENES = {
    # 1. floating panel opens on the item list (cold start hint + dsh UI)
    "panel-open": [
        ["maxwin"],
        ["bridge", "debug.open", '{"mode":"list"}'],
        ["wait", "16"],
        ["shot", "panel-open-check"],
        ["wait", "2"],
    ],
    # 2. switch panel <-> full tab and back
    "host-switch": [
        ["bridge", "debug.open", '{"host":"tab"}'],
        ["wait", "6"],
        ["bridge", "debug.open", '{"host":"panel"}'],
        ["wait", "5"],
    ],
    # 3. reader-bound assistant for the CRISPR paper (item 193)
    "reader-assist": [
        ["bridge", "debug.openreader", '{"itemID":193}'],
        ["wait", "7"],
        ["bridge", "debug.open", '{"mode":"reader","itemID":193}'],
        ["wait", "6"],
    ],
    # 4. real drag-select on the paper title -> auto stream translation
    "translate": [
        ["bridge", "debug.open", '{"host":"hide"}'],
        ["wait", "1"],
        ["click", "1800", "900"],
        ["wait", "1"],
        ["drag", "560", "770", "1055", "790"],
        ["wait", "25"],
    ],
    # 4b. full translate flow: select abstract -> stream -> add to comment -> annotation sidebar
    "translate-full": [
        ["bridge", "debug.open", '{"host":"hide"}'],
        ["wait", "1"],
        ["click", "1800", "900"],
        ["wait", "1"],
        ["drag", "560", "470", "1655", "505"],
        ["wait", "28"],
        ["wheel", "1015", "700", "-3"],
        ["wait", "2"],
        ["click", "1015", "870"],
        ["wait", "4"],
        ["click", "1800", "900"],
        ["wait", "0.8"],
        ["click", "44", "104"],
        ["wait", "3"],
    ],
    # 5. click "add to comment" -> underline annotation with translated comment
    "add-comment": [
        ["bridge", "debug.open", '{"host":"hide"}'],
        ["wait", "1"],
        ["click", "1868", "1366"],
        ["wait", "4"],
        ["click", "3200", "1900"],
        ["wait", "0.8"],
        ["click", "36", "166"],
        ["wait", "3"],
    ],
    # 6. show the broken metadata, run AI refetch, watch the task session work
    "refetch": [
        ["click", "83", "68"],
        ["wait", "2"],
        ["click", "97", "544"],
        ["wait", "2.5"],
        ["click", "727", "205"],
        ["wait", "2"],
        ["bridge", "debug.open", '{"host":"panel"}'],
        ["wait", "3"],
        ["bridge", "debug.refetch", '{"items":[193]}'],
        ["wait", "10"],
        ["waititem", "193", "120"],
        ["wait", "25"],
    ],
    # 7. reveal the restored metadata in the item pane
    "result-reveal": [
        ["bridge", "debug.open", '{"host":"hide"}'],
        ["wait", "1"],
        ["click", "83", "68"],
        ["wait", "2"],
        ["click", "97", "544"],
        ["wait", "2.5"],
        ["click", "727", "205"],
        ["wait", "4"],
    ],
    # 8. settings pane (dsh source + translate options)
    "settings": [
        ["bridge", "debug.prefs", '{"waitMs":3500}'],
        ["wait", "5"],
        ["closewin", "Zotero 设置"],
    ],
}


def main():
    os.makedirs(os.path.join(OUT, "frames"), exist_ok=True)
    if len(sys.argv) >= 2 and sys.argv[1] == "list":
        for k in SCENES:
            print(k)
        return
    which = sys.argv[2:] if len(sys.argv) > 2 else list(SCENES)
    for name in (which if sys.argv[1] != "all" else SCENES):
        record(name, SCENES[name])


if __name__ == "__main__":
    main()
