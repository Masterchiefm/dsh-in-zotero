#!/usr/bin/env python3
"""宣传片合成：解说(TTS) + 字幕烧录 + 片头/章节页 + 五段实机录屏。

流程（全部幂等，可分段重跑）：
  1. 逐句 TTS（DeepSeek /v1/tools/tts，24kHz PCM；按句合成以拿到精确时长）
  2. 排时间轴：每段时长 = max(视频需要, 旁白需要)，录屏不够长就冻结末帧
  3. 拼每段的旁白音轨（wave 模块，句间静音）
  4. Edge 无头截图渲染片头/章节页（SVG 无，纯 CSS）
  5. 每段编码成 .ts（h264+aac 同参数），concat demuxer 无损拼接
  6. 一遍重编码烧录 ASS 字幕 → docs/promo.mp4

用法：
    python scripts/demo/build_promo.py               # 全流程（命中缓存则快）
    python scripts/demo/build_promo.py --voice tide  # 换音色
    python scripts/demo/build_promo.py --no-burn     # 只合成不烧字幕（调试）
"""

import hashlib
import json
import os
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = Path(__file__).resolve().parent / "promo-assets"
BUILD = (Path(os.environ["DSH_PROMO_BUILD"]) if os.environ.get("DSH_PROMO_BUILD")
         else Path.home() / "AppData/Local/Temp/dsh-promo/build")
OUT = ROOT / "docs" / "promo.mp4"

W, H, FPS = 1728, 1080, 30
VOICE = "stella"
TTS_URL = "https://api.deepseek.com/v1/tools/tts"
TTS_KEY = "sk-85b7dad11ddc4a019139b4bbe6568fdd"
SR, CH, SW = 24000, 1, 2          # TTS PCM: 24kHz 单声道 s16le
OUT_SR = 44100                    # 成片音轨统一重采样
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
AVATAR_SHEET = r"C:\Users\moqiq\Downloads\1794077967954.jpeg"

# BGM：坎巴拉太空计划（KSP）建造大楼（VAB/SPH）配乐，游戏内文件名 Construction01，
# Kevin MacLeod 曲（CC-BY，发布视频需署名）。恒定音量不做闪避（忽大忽小听着难受）：
# 原曲 mean -19.6dB；×0.24 → 全程 ≈ -32dBFS 垫底（旁白 -23dB，音乐可闻且恒定）。
BGM_SRC = ASSETS / "bgm-construction.m4a"
BGM_VOL = 0.24

LEAD, GAP, TAIL = 0.45, 0.45, 0.9  # 段首留白 / 句间间隔 / 段尾留白（秒）

# ---------------------------------------------------------------- 解说脚本

SCRIPT = [
    dict(
        id="opening", kind="slide", layout="hero",
        title="Zotero 插件，越装越多", kicker="痛点",
        pitch="想要的每个功能，都对应一个要装的插件",
        bullets=["划词翻译 · 元数据抓取 · 批量整理 · 附件管理……",
                 "功能分散、风格各异、更新停更",
                 "重复造轮子，还可能互相冲突"],
        illustration="ill-chaos.png",
        lines=["用 Zotero 做科研的你，是不是也装了一堆插件？",
               "翻译一个，抓取一个，批量整理又是一堆；",
               "想要的功能分散在各个插件里，还可能互相冲突。"],
    ),
    dict(
        id="intro", kind="slide", layout="hero",
        title="Zotero 里的全能 Agent", kicker="换一种思路",
        pitch="dsh-in-zotero —— 把 DeepSeek Harness（dsh）整个内置进 Zotero",
        bullets=["功能不再写死在插件里：Agent 拿着 21 个文献工具自己干活",
                 "检索 / 阅读 / 翻译 / 整理 / 写入，全部自主调用",
                 "开源：github.com/Masterchiefm/dsh-in-zotero"],
        illustration="ill-hero.png",
        lines=["其实，Zotero 缺的不是第一百个插件，而是一个能干活的 AI。",
               "这个插件，把 DeepSeek Harness 整个塞进了 Zotero。",
               "它是一个全能的 Agent：检索、阅读、翻译、整理，样样都行，",
               "任何你想要的功能，它都能自己实现。"],
    ),
    dict(
        id="f1-title", kind="slide", layout="chapter",
        num="01", title="AI 辅助阅读", pitch="阅读页一键唤醒，会话绑定当前文献",
        lines=["先看第一个基础功能：AI 辅助阅读。"],
    ),
    dict(
        id="f1", kind="recording", src=r"C:\Users\moqiq\Downloads\ai辅助阅读.mp4",
        lines=["在 PDF 里一键唤醒对话窗，会话自动绑定当前文献。",
               "问它「这篇文章讲了什么」，它会自己读完全文再回答。"],
    ),
    dict(
        id="f2-title", kind="slide", layout="chapter",
        num="02", title="划词翻译", pitch="划选即译，译文流式呈现",
        lines=["第二个功能：划词翻译。"],
    ),
    dict(
        id="f2", kind="recording", src=r"C:\Users\moqiq\Downloads\划词翻译.mp4",
        lines=["划选任意文字，译文流式呈现，还能一键存成批注。"],
    ),
    dict(
        id="f3-title", kind="slide", layout="chapter",
        num="03", title="整理文献库", pitch="一句话给全库做体检",
        lines=["第三个功能：整理文献库。"],
    ),
    dict(
        id="f3", kind="recording", src=r"C:\Users\moqiq\Downloads\文献库整理.mp4",
        at=[1.0, 8.0, 24.5],
        lines=["面对几百条文献，一句话就能让 Agent 做全面体检。",
               "它自己遍历分类和条目，重复条目、游离 PDF、空分类，全都翻出来。",
               "最后生成一份结构化的清理报告——改不改，由你决定。"],
    ),
    dict(
        id="f4-title", kind="slide", layout="chapter",
        num="04", title="AI 重取元数据", pitch="乱码题录一键修复",
        lines=["第四个功能：AI 重新获取元数据。"],
    ),
    dict(
        id="f4", kind="recording", src=r"C:\Users\moqiq\Downloads\文献数据更新.mp4",
        at=[0.8, 5.3, 11.2],
        lines=["拖进库里没识别的 PDF，题录一团糟？",
               "右键一下，Agent 从 PDF 首页提取 DOI，联网核对，",
               "正确的标题、作者、期刊，原地写回。"],
    ),
    dict(
        id="wish-title", kind="slide", layout="chapter",
        num="05", title="功能许愿", pitch="缺什么功能，让 Agent 现场做",
        lines=["更酷的是——缺什么功能，直接许愿。"],
    ),
    dict(
        id="wish", kind="recording", src=r"C:\Users\moqiq\Downloads\许愿.mp4",
        at=[1.5, 12.0, 21.5],
        lines=["打开设置面板，点一下许愿按钮，",
               "就会打开一个许愿会话，Agent 跟你把需求聊清楚，",
               "然后它自己读插件源码、动手实现，改完还会问你要不要提交 PR。"],
    ),
    dict(
        id="closing", kind="slide", layout="hero",
        title="内置 dsh，功能无限", kicker="总结",
        pitch="基础功能开箱即用；想要的一切，让 Agent 实现",
        bullets=["五个基础功能：阅读 / 翻译 / 整理 / 元数据 / 许愿",
                 "想要的新功能，许个愿就长出来",
                 "开源：github.com/Masterchiefm/dsh-in-zotero"],
        illustration="ill-final.png",
        lines=["阅读助手、划词翻译、文库整理、元数据重取、功能许愿——这些只是冰山一角。",
               "因为内置了 dsh，它可以实现任何你想要的功能。",
               "GitHub 搜索 dsh-in-zotero，给你的 Zotero 装一个全能 Agent。"],
    ),
]

# ---------------------------------------------------------------- TTS

def tts_wav(text: str, voice: str) -> Path:
    """单句 TTS → wav（按 text+voice 哈希缓存）。"""
    h = hashlib.sha1(f"{voice}|{text}".encode()).hexdigest()[:16]
    wav = BUILD / "tts" / f"{h}.wav"
    if wav.exists():
        return wav
    wav.parent.mkdir(parents=True, exist_ok=True)
    import urllib.request

    body = json.dumps({"text": text, "voice_id": voice,
                       "format": "pcm", "filter_markdown": True}).encode()
    last_err = None
    for _ in range(3):
        try:
            req = urllib.request.Request(TTS_URL, data=body, headers={
                "Authorization": "Bearer " + TTS_KEY,
                "Content-Type": "application/json"})
            pcm = urllib.request.urlopen(req, timeout=60).read()
            if len(pcm) < 2000:
                raise RuntimeError(f"pcm too short: {len(pcm)}")
            with wave.open(str(wav), "wb") as w:
                w.setnchannels(CH); w.setsampwidth(SW); w.setframerate(SR)
                w.writeframes(pcm)
            return wav
        except Exception as e:  # 重试
            last_err = e
    raise RuntimeError(f"TTS failed for {text!r}: {last_err}")


def wav_frames(path: Path) -> bytes:
    with wave.open(str(path), "rb") as w:
        assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (SR, CH, SW), path
        return w.readframes(w.getnframes())


def silence(seconds: float) -> bytes:
    n = int(round(seconds * SR)) * CH * SW
    return b"\x00" * n


# ---------------------------------------------------------------- 时间轴

def build_timeline() -> dict:
    """给每段配旁白音轨并排定全局时间。返回 manifest（含 ASS 用句时刻）。"""
    parts, cursor, cues = [], 0.0, []
    for seg in SCRIPT:
        # 逐句时长
        durs = []
        for t in seg["lines"]:
            with wave.open(str(tts_wav(t, VOICE)), "rb") as w:
                durs.append(w.getnframes() / SR)

        at = seg.get("at")
        if at is None:  # 顺序排布
            at, t = [], LEAD
            for d in durs:
                at.append(t)
                t += d + GAP
            last_end = t - GAP
        else:
            assert len(at) == len(durs), seg["id"]
            last_end = max(a + d for a, d in zip(at, durs))

        if seg["kind"] == "recording":
            import imageio_ffmpeg
            ff = imageio_ffmpeg.get_ffmpeg_exe()
            p = subprocess.run([ff, "-hide_banner", "-i", seg["src"]], capture_output=True, text=True)
            rec_dur = 0.0
            for ln in p.stderr.splitlines():
                if "Duration" in ln:
                    hh, mm, ss = ln.split("Duration: ")[1].split(",")[0].strip().split(":")
                    rec_dur = int(hh) * 3600 + int(mm) * 60 + float(ss)
            duration = max(rec_dur, last_end + 0.4)
        else:
            duration = last_end + TAIL

        sentences = [dict(text=t, at=cursor + a, dur=d)
                     for t, a, d in zip(seg["lines"], at, durs)]
        cues += sentences
        parts.append(dict(id=seg["id"], kind=seg["kind"], duration=round(duration, 3),
                          start=round(cursor, 3), sentences=sentences))
        cursor += duration
    return dict(total=round(cursor, 3), parts=parts, cues=cues)


def render_part_audio(seg: dict, tl_part: dict) -> Path:
    """拼一段的旁白：按句位置摆放，其余补静音；总长 = 段时长。"""
    out = BUILD / "audio" / f"{seg['id']}.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    total_frames = int(round(tl_part["duration"] * SR))
    buf = bytearray(total_frames * CH * SW)

    def put(frames: bytes, at_sec: float):
        ofs = int(round(at_sec * SR)) * CH * SW
        end = min(ofs + len(frames), len(buf))
        buf[ofs:end] = frames[: end - ofs]

    for s in tl_part["sentences"]:
        put(wav_frames(tts_wav(s["text"], VOICE)), s["at"] - tl_part["start"])
    with wave.open(str(out), "wb") as w:
        w.setnchannels(CH); w.setsampwidth(SW); w.setframerate(SR)
        w.writeframes(bytes(buf))
    return out


# ---------------------------------------------------------------- 幻灯片

def avatar_front() -> Path:
    """从三视图 character sheet 裁正面立绘（去白边）。"""
    out = ASSETS / "avatar-front.png"
    if out.exists():
        return out
    from PIL import Image
    im = Image.open(AVATAR_SHEET)
    w, h = im.size
    left = im.crop((0, 0, int(w * 0.36), h))
    gray = left.convert("L").point(lambda p: 0 if p > 242 else 255)
    box = gray.getbbox()
    if box:
        pad = 6
        box = (max(0, box[0] - pad), max(0, box[1] - pad),
               min(left.width, box[2] + pad), min(left.height, box[3] + pad))
        left = left.crop(box)
    ASSETS.mkdir(parents=True, exist_ok=True)
    left.save(out)
    return out


SLIDE_CSS = """
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:%(W)spx; height:%(H)spx; overflow:hidden; }
  body { font-family:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
         background:#0A0D13; color:#fff; position:relative; }
  .glow { position:absolute; border-radius:50%%; filter:blur(140px); }
  .g1 { width:900px; height:620px; left:-260px; top:-280px; background:rgba(43,108,255,.20); }
  .g2 { width:860px; height:600px; right:-240px; bottom:-300px; background:rgba(124,92,255,.16); }
  .grid { position:absolute; inset:0;
    background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);
    background-size:96px 96px; }
  .wrap { position:absolute; inset:0; padding:64px 96px 56px; display:flex; flex-direction:column; }
  header { display:flex; justify-content:space-between; align-items:center; }
  .brand { display:flex; align-items:center; gap:18px; font-size:26px; color:#e8ecf4; }
  .zlogo { width:40px; height:40px; border-radius:10px; font-weight:700; font-size:26px;
    background:linear-gradient(135deg,#CC2936,#8f1d26); display:flex; align-items:center;
    justify-content:center; }
  .brand .dim { color:#6b7484; font-weight:400; }
  .idx { font-size:24px; color:#6b7484; letter-spacing:2px; }
  footer { display:flex; justify-content:space-between; align-items:center;
    border-top:1px solid rgba(255,255,255,.08); padding-top:26px;
    font-size:22px; color:#6b7484; letter-spacing:1px; }
  footer b { color:#9aa3b4; font-weight:600; }
  .kicker { display:inline-flex; align-items:center; gap:14px; margin-bottom:30px;
    font-size:27px; font-weight:600; letter-spacing:6px; color:transparent;
    background:linear-gradient(90deg,#4D8DFF,#9D7BFF);
    -webkit-background-clip:text; background-clip:text; }
  .kicker::before { content:""; width:46px; height:4px; border-radius:2px;
    background:linear-gradient(90deg,#4D8DFF,#9D7BFF); }
"""

HERO_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
%(css)s
  main { flex:1; display:flex; align-items:center; gap:56px; }
  .col { flex:1; max-width:920px; }
  h1 { font-size:68px; font-weight:700; letter-spacing:3px; line-height:1.2; }
  .pitch { margin-top:24px; font-size:30px; color:#9aa3b4; letter-spacing:1px; line-height:1.5; }
  .points { margin-top:46px; list-style:none; display:flex; flex-direction:column; gap:22px; }
  .points li { display:flex; align-items:center; gap:20px; font-size:26px; color:#d5dae4;
    letter-spacing:1px; background:rgba(255,255,255,.035);
    border:1px solid rgba(255,255,255,.07); border-radius:16px;
    padding:20px 28px; width:fit-content; max-width:100%%; }
  .n { flex:none; width:40px; height:40px; border-radius:12px; font-size:20px; font-weight:700;
    display:flex; align-items:center; justify-content:center;
    color:#fff; background:linear-gradient(135deg,#3D7BFF,#8B5CF6); }
  .art { flex:none; width:560px; height:560px; border-radius:28px; overflow:hidden;
    border:1px solid rgba(120,140,255,.25); box-shadow:0 0 90px rgba(80,100,255,.18);
    background:#0F1420; }
  .art img { width:100%%; height:100%%; object-fit:cover; display:block; }
</style></head><body>
  <div class="glow g1"></div><div class="glow g2"></div><div class="grid"></div>
  <div class="wrap">
    <header>
      <div class="brand"><div class="zlogo">Z</div>
        <span><b>dsh-in-zotero</b>&nbsp;&nbsp;<span class="dim">Zotero 里的 DeepSeek Harness</span></span></div>
      <div class="idx">%(idx)s</div>
    </header>
    <main>
      <div class="col">
        <div class="kicker">%(kicker)s</div>
        <h1>%(title)s</h1>
        <div class="pitch">%(pitch)s</div>
        <ul class="points">%(points)s</ul>
      </div>
      %(art)s
    </main>
    <footer>
      <span>真实模型调用 · 所有文库写入经 <b>Zotero 官方接口</b></span>
      <span>github.com/Masterchiefm/<b>dsh-in-zotero</b></span>
    </footer>
  </div>
</body></html>
"""

CHAPTER_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
%(css)s
  main { flex:1; display:flex; align-items:center; justify-content:center; gap:80px; }
  .avatar { flex:none; width:520px; height:520px; border-radius:50%%; background:#f4f6fb;
    border:6px solid rgba(120,140,255,.35); box-shadow:0 0 110px rgba(80,100,255,.22);
    display:flex; align-items:flex-end; justify-content:center; overflow:hidden; }
  .avatar img { width:92%%; height:auto; display:block; }
  .col { max-width:860px; }
  .num { font-size:120px; font-weight:800; line-height:1; letter-spacing:2px;
    background:linear-gradient(135deg,#4D8DFF,#9D7BFF);
    -webkit-background-clip:text; background-clip:text; color:transparent; }
  h1 { font-size:104px; font-weight:700; letter-spacing:4px; margin-top:24px; }
  .pitch { margin-top:30px; font-size:36px; color:#9aa3b4; letter-spacing:1px; }
</style></head><body>
  <div class="glow g1"></div><div class="glow g2"></div><div class="grid"></div>
  <div class="wrap">
    <header>
      <div class="brand"><div class="zlogo">Z</div>
        <span><b>dsh-in-zotero</b>&nbsp;&nbsp;<span class="dim">Zotero 里的 DeepSeek Harness</span></span></div>
      <div class="idx">%(idx)s</div>
    </header>
    <main>
      <div class="avatar"><img src="%(avatar)s"></div>
      <div class="col">
        <div class="num">%(num)s</div>
        <div class="kicker">%(kicker)s</div>
        <h1>%(title)s</h1>
        <div class="pitch">%(pitch)s</div>
      </div>
    </main>
    <footer>
      <span>真实模型调用 · 所有文库写入经 <b>Zotero 官方接口</b></span>
      <span>github.com/Masterchiefm/<b>dsh-in-zotero</b></span>
    </footer>
  </div>
</body></html>
"""


def render_slide(seg: dict, png: Path) -> None:
    import html as htmlmod
    esc = htmlmod.escape
    idx = {"opening": "开场", "intro": "方案", "closing": "总结"}.get(seg["id"], "")
    if seg["layout"] == "hero":
        ill = ASSETS / seg.get("illustration", "")
        art = ('<div class="art"><img src="%s"></div>' % ill.as_uri()) if ill.exists() else ""
        points = "".join(
            '<li><span class="n">%d</span><span>%s</span></li>' % (i, esc(t))
            for i, t in enumerate(seg["bullets"], 1))
        doc = HERO_HTML % dict(css=SLIDE_CSS % dict(W=W, H=H), idx=idx, kicker=esc(seg["kicker"]),
                              title=esc(seg["title"]), pitch=esc(seg["pitch"]), points=points, art=art)
    else:  # chapter
        avatar = avatar_front()
        doc = CHAPTER_HTML % dict(css=SLIDE_CSS % dict(W=W, H=H), idx="",
                                  avatar=avatar.as_uri(), num=seg["num"], kicker="基础功能",
                                  title=esc(seg["title"]), pitch=esc(seg["pitch"]))
    html_path = png.with_suffix(".html")
    html_path.write_text(doc, encoding="utf-8")
    subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=1", f"--window-size={W},{H}",
                    f"--screenshot={png}", html_path.as_uri()],
                   check=True, capture_output=True)
    if not png.exists() or png.stat().st_size < 10_000:
        raise RuntimeError(f"slide render failed: {png}")


# ---------------------------------------------------------------- 分段渲染

def ffprobe_duration(ff: str, path: Path) -> float:
    p = subprocess.run([ff, "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    for ln in p.stderr.splitlines():
        if "Duration" in ln:
            hh, mm, ss = ln.split("Duration: ")[1].split(",")[0].strip().split(":")
            return int(hh) * 3600 + int(mm) * 60 + float(ss)
    raise RuntimeError(f"no duration: {path}")


def render_part(seg: dict, tl_part: dict, audio: Path, ff: str) -> Path:
    ts = BUILD / "parts" / f"{seg['id']}.ts"
    ts.parent.mkdir(parents=True, exist_ok=True)
    D = tl_part["duration"]
    venc = ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"]
    aenc = ["-c:a", "aac", "-ar", str(OUT_SR), "-ac", "2", "-b:a", "160k"]
    if seg["kind"] == "slide":
        png = BUILD / "slides" / f"{seg['id']}.png"
        png.parent.mkdir(parents=True, exist_ok=True)
        if not png.exists():
            render_slide(seg, png)
        fo = D - 0.3
        vf = f"scale={W}:{H},setsar=1,fps={FPS},format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st={fo:.2f}:d=0.3"
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error",
               "-loop", "1", "-t", f"{D:.3f}", "-i", str(png), "-i", str(audio),
               "-vf", vf, "-map", "0:v", "-map", "1:a", *venc, *aenc,
               "-shortest", "-f", "mpegts", str(ts)]
    else:
        rec = ffprobe_duration(ff, Path(seg["src"]))
        extra = D - rec
        if extra > 0.05:
            vf = f"tpad=stop_mode=clone:stop_duration={extra + 0.5:.3f},scale={W}:{H},setsar=1,fps={FPS},format=yuv420p"
        else:
            vf = f"scale={W}:{H},setsar=1,fps={FPS},format=yuv420p"
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-i", seg["src"], "-i", str(audio),
               "-vf", vf, "-map", "0:v", "-map", "1:a", *venc, *aenc, "-t", f"{D:.3f}",
               "-f", "mpegts", str(ts)]
    subprocess.run(cmd, check=True)
    return ts


def write_ass(cues: list, path: Path) -> None:
    def ts(sec: float) -> str:
        cs = int(round(sec * 100))
        return f"{cs // 360000}:{cs % 360000 // 6000:02d}:{cs % 6000 / 100:05.2f}"

    lines = [
        "[Script Info]", "ScriptType: v4.00+",
        f"PlayResX: {W}", f"PlayResY: {H}", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Sub,Microsoft YaHei,48,&H00FFFFFF,&H00FFFFFF,&HB410141A,&H66000000,"
        "1,0,0,0,100,100,0,0,1,2.6,1.1,2,90,90,74,1", "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for i, c in enumerate(cues):
        end = c["at"] + c["dur"] + 0.85
        if i + 1 < len(cues):                       # 不与下一句重叠
            end = min(end, cues[i + 1]["at"] - 0.05)
        end = min(end, c["at"] + 12)
        text = c["text"].replace("\n", " ")
        lines.append(f"Dialogue: 0,{ts(c['at'])},{ts(end)},Sub,,0,0,0,,{{\\fad(120,120)}}{text}")
    path.write_text("\n".join(lines), encoding="utf-8")


def prep_bgm(ff: str, total: float) -> Path | None:
    """BGM 预处理：循环到成片长度（接缝 2.5s 交叉淡化）+ 音量 + 首尾淡化。"""
    if not BGM_SRC.exists():
        return None
    out = BUILD / "bgm.wav"
    fade_st = max(0.0, total - 3.5)
    subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(BGM_SRC), "-stream_loop", "1", "-i", str(BGM_SRC),
                    "-filter_complex",
                    f"[0:a][1:a]acrossfade=d=2.5:c1=tri:c2=tri[lp];"
                    f"[lp]aformat=sample_rates=44100:channel_layouts=stereo,"
                    f"atrim=0:{total:.3f},volume={BGM_VOL},"
                    f"afade=t=in:st=0:d=1.2,afade=t=out:st={fade_st:.3f}:d=3.5,"
                    f"apad=whole_dur={total:.3f}[out]",
                    "-map", "[out]", "-c:a", "pcm_s16le",
                    "-ar", "44100", "-ac", "2", str(out)],
                   check=True)
    return out


# ---------------------------------------------------------------- 主流程

def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    voice = VOICE
    if "--voice" in sys.argv:
        voice = sys.argv[sys.argv.index("--voice") + 1]
    burn = "--no-burn" not in sys.argv

    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    BUILD.mkdir(parents=True, exist_ok=True)

    print("[1/5] TTS + timeline ...", flush=True)
    tl = build_timeline()
    (BUILD / "timeline.json").write_text(
        json.dumps(tl, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"      total {tl['total']:.1f}s", flush=True)

    print("[2/5] part audio ...", flush=True)
    audios = {seg["id"]: render_part_audio(seg, p) for seg, p in zip(SCRIPT, tl["parts"])}

    print("[3/5] slides ...", flush=True)
    for seg in SCRIPT:
        if seg["kind"] == "slide":
            png = BUILD / "slides" / f"{seg['id']}.png"
            png.parent.mkdir(parents=True, exist_ok=True)
            if not png.exists():
                render_slide(seg, png)
            print(f"      {seg['id']}.png", flush=True)

    print("[4/5] part videos ...", flush=True)
    ts_files = [render_part(seg, p, audios[seg["id"]], ff)
                for seg, p in zip(SCRIPT, tl["parts"])]
    listing = BUILD / "concat.txt"
    listing.write_text("".join(f"file 'parts/{t.name}'\n" for t in ts_files), encoding="utf-8")
    merged = BUILD / "all.ts"
    subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat",
                    "-safe", "0", "-i", str(listing), "-c", "copy", str(merged)], check=True)

    if burn:
        print("[5/5] burn subtitles + BGM ...", flush=True)
        write_ass(tl["cues"], BUILD / "subs.ass")
        OUT.parent.mkdir(exist_ok=True)
        bgm = prep_bgm(ff, tl["total"])
        enc = ["-c:v", "libx264", "-crf", "18", "-preset", "medium",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        if bgm:
            # 恒定音量混音，不做闪避
            subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error",
                            "-i", str(merged), "-i", "bgm.wav",
                            "-vf", "ass=subs.ass",
                            "-filter_complex",
                            "[0:a][1:a]amix=inputs=2:duration=first:normalize=0,"
                            "alimiter=limit=0.95[aout]",
                            "-map", "0:v", "-map", "[aout]",
                            "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k",
                            *enc, str(OUT)],
                           check=True, cwd=str(BUILD))
        else:
            subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error",
                            "-i", str(merged), "-vf", "ass=subs.ass",
                            *enc, "-c:a", "copy", str(OUT)],
                           check=True, cwd=str(BUILD))
        print(f"done -> {OUT}  ({OUT.stat().st_size / 1_048_576:.1f} MB)")
    else:
        print(f"done (no burn) -> {merged}")


if __name__ == "__main__":
    main()
