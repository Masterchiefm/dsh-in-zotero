#!/usr/bin/env python3
"""把人工录屏素材剪辑成演示视频：每段前拼一张 4 秒总结片头。

片头用内嵌 HTML 模板排版（1728×1080，深色主题），Edge 无头模式截图成 PNG，
再用 ffmpeg（默认取 imageio-ffmpeg 自带二进制）把 片头(4s, 淡入淡出) + 录屏
单次滤镜图拼接，统一转 H.264 yuv420p + faststart（GitHub/浏览器可直接播放）。
源音频轨近似静音，一律丢弃。

用法：
    python scripts/demo/build_demo.py            # 全部四段
    python scripts/demo/build_demo.py 1 3        # 只重做第 1、3 段
"""

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "docs"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
W, H = 1728, 1080          # 源录屏原生分辨率（16:10），全画幅不加黑边
SLIDE_SECONDS = 4
FPS = 30

SEGMENTS = [
    {
        "num": "01",
        "src": r"C:\Users\moqiq\Downloads\ai辅助阅读.mp4",
        "out": "demo-1-ai-reading.mp4",
        "title": "AI 辅助阅读",
        "pitch": "阅读页一键唤醒对话窗，AI 自己翻论文、基于全文回答",
        "points": [
            "会话与当前文献绑定，自动带上题录与全文上下文",
            "「这篇文章讲了什么？」直接问，无需复制粘贴",
            "悬浮窗 / 标签页双宿主，边读边问不切屏",
        ],
    },
    {
        "num": "02",
        "src": r"C:\Users\moqiq\Downloads\划词翻译.mp4",
        "out": "demo-2-translate.mp4",
        "title": "划词翻译",
        "pitch": "PDF 划选即出弹窗，「自动」模式划选即翻，译文流式呈现",
        "points": [
            "「译」按钮点击翻译，「自动」开关划选立即翻",
            "深度思考模式：思考过程实时显示，结束后折叠可回看",
            "「添加到评论」一键生成下划线批注 + 译文",
        ],
    },
    {
        "num": "03",
        "src": r"C:\Users\moqiq\Downloads\文献库整理.mp4",
        "out": "demo-3-library.mp4",
        "title": "文献库整理",
        "pitch": "一句话让 AI 给整个文献库做体检，重复、游离、错归档无处遁形",
        "points": [
            "「帮我看看文献库有没有什么需要整理的」——自然语言即指令",
            "AI 自主遍历分类与条目，梳理重复条目、游离 PDF、空分类",
            "输出结构化清理报告，改不改由你决定",
        ],
    },
    {
        "num": "04",
        "src": r"C:\Users\moqiq\Downloads\文献数据更新.mp4",
        "out": "demo-4-refetch.mp4",
        "title": "文献数据更新",
        "pitch": "题录是乱码也没关系——右键一键，AI 识别、查库、写回",
        "points": [
            "右键菜单「AI 重新获取元数据」，每个条目独立任务会话",
            "从 PDF 首页提取 DOI，Crossref / OpenAlex / arXiv / PubMed 核对",
            "核实后原地写回，独立 PDF 直接建条目并挂接附件",
        ],
    },
]

SLIDE_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  html, body {{ width: {w}px; height: {h}px; overflow: hidden; }}
  body {{
    font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
    background: #0A0D13; color: #fff;
    position: relative;
  }}
  .glow {{ position: absolute; border-radius: 50%; filter: blur(140px); }}
  .g1 {{ width: 900px; height: 620px; left: -260px; top: -280px;
        background: rgba(43,108,255,.20); }}
  .g2 {{ width: 860px; height: 600px; right: -240px; bottom: -300px;
        background: rgba(124,92,255,.16); }}
  .grid {{ position: absolute; inset: 0;
    background-image: linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
                      linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);
    background-size: 96px 96px; }}
  .wrap {{ position: absolute; inset: 0; padding: 64px 96px 56px;
    display: flex; flex-direction: column; }}
  header {{ display: flex; justify-content: space-between; align-items: center; }}
  .brand {{ display: flex; align-items: center; gap: 18px; font-size: 26px; color: #e8ecf4; }}
  .zlogo {{ width: 40px; height: 40px; border-radius: 10px; font-weight: 700; font-size: 26px;
    background: linear-gradient(135deg, #CC2936, #8f1d26);
    display: flex; align-items: center; justify-content: center; }}
  .brand b {{ font-weight: 700; }}
  .brand .dim {{ color: #6b7484; font-weight: 400; }}
  .idx {{ font-size: 24px; color: #6b7484; font-variant-numeric: tabular-nums; letter-spacing: 2px; }}
  main {{ flex: 1; display: flex; flex-direction: column; justify-content: center;
    max-width: 1380px; }}
  .kicker {{ display: inline-flex; align-items: center; gap: 14px; margin-bottom: 30px;
    font-size: 27px; font-weight: 600; letter-spacing: 6px;
    background: linear-gradient(90deg, #4D8DFF, #9D7BFF);
    -webkit-background-clip: text; background-clip: text; color: transparent; }}
  .kicker::before {{ content: ""; width: 46px; height: 4px; border-radius: 2px;
    background: linear-gradient(90deg, #4D8DFF, #9D7BFF); }}
  h1 {{ font-size: 104px; font-weight: 700; letter-spacing: 3px; line-height: 1.15; }}
  .pitch {{ margin-top: 28px; font-size: 35px; color: #9aa3b4; letter-spacing: 1px;
    line-height: 1.5; }}
  .points {{ margin-top: 58px; list-style: none; display: flex; flex-direction: column;
    gap: 26px; }}
  .points li {{ display: flex; align-items: center; gap: 24px; font-size: 30px;
    color: #d5dae4; letter-spacing: 1px;
    background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.07);
    border-radius: 16px; padding: 24px 32px; width: fit-content; padding-right: 44px; }}
  .n {{ flex: none; width: 44px; height: 44px; border-radius: 12px; font-size: 22px;
    font-weight: 700; display: flex; align-items: center; justify-content: center;
    color: #fff; background: linear-gradient(135deg, #3D7BFF, #8B5CF6); }}
  footer {{ display: flex; justify-content: space-between; align-items: center;
    border-top: 1px solid rgba(255,255,255,.08); padding-top: 26px;
    font-size: 22px; color: #6b7484; letter-spacing: 1px; }}
  footer b {{ color: #9aa3b4; font-weight: 600; }}
</style></head>
<body>
  <div class="glow g1"></div><div class="glow g2"></div><div class="grid"></div>
  <div class="wrap">
    <header>
      <div class="brand">
        <div class="zlogo">Z</div>
        <span><b>dsh-in-zotero</b>&nbsp;&nbsp;<span class="dim">Zotero 里的 DeepSeek Harness</span></span>
      </div>
      <div class="idx">{num} / 04</div>
    </header>
    <main>
      <div class="kicker">实机演示</div>
      <h1>{title}</h1>
      <div class="pitch">{pitch}</div>
      <ul class="points">
        {points}
      </ul>
    </main>
    <footer>
      <span>真实模型调用 · 所有文库写入经 <b>Zotero 官方接口</b>，绝不直接读写数据库</span>
      <span>github.com/Masterchiefm/<b>dsh-in-zotero</b></span>
    </footer>
  </div>
</body></html>
"""


def ffmpeg_exe() -> str:
    """优先 imageio-ffmpeg 自带二进制，退回 PATH 里的 ffmpeg。"""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return "ffmpeg"


def render_slide(seg: dict, png: Path) -> None:
    html_path = png.with_suffix(".html")
    items = "\n".join(
        f'        <li><span class="n">{i}</span><span>{t}</span></li>'
        for i, t in enumerate(seg["points"], 1)
    )
    html_path.write_text(
        SLIDE_HTML.format(w=W, h=H, num=seg["num"], title=seg["title"],
                          pitch=seg["pitch"], points=items),
        encoding="utf-8",
    )
    url = html_path.as_uri()
    subprocess.run(
        [EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=1", f"--window-size={W},{H}",
         f"--screenshot={png}", url],
        check=True, capture_output=True,
    )
    if not png.exists() or png.stat().st_size < 10_000:
        raise RuntimeError(f"片头截图异常: {png}")


def assemble(seg: dict, slide_png: Path, ff: str) -> Path:
    out = OUT_DIR / seg["out"]
    fade_out_start = SLIDE_SECONDS - 0.45
    vf = (
        f"[0:v]scale={W}:{H},setsar=1,fps={FPS},format=yuv420p,"
        f"fade=t=in:st=0:d=0.35,fade=t=out:st={fade_out_start}:d=0.45[v0];"
        f"[1:v]fps={FPS},scale={W}:{H},setsar=1,format=yuv420p[v1];"
        f"[v0][v1]concat=n=2:v=1:a=0[v]"
    )
    subprocess.run(
        [ff, "-y", "-hide_banner", "-loglevel", "error",
         "-loop", "1", "-t", str(SLIDE_SECONDS), "-i", str(slide_png),
         "-i", seg["src"],
         "-filter_complex", vf, "-map", "[v]",
         "-c:v", "libx264", "-crf", "18", "-preset", "medium",
         "-movflags", "+faststart", "-an", str(out)],
        check=True,
    )
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    wanted = {int(a) for a in sys.argv[1:]} or set(range(1, len(SEGMENTS) + 1))
    ff = ffmpeg_exe()
    OUT_DIR.mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="dsh-demo-"))
    print(f"workdir: {work}")
    for i, seg in enumerate(SEGMENTS, 1):
        if i not in wanted:
            continue
        print(f"[{seg['num']}] {seg['title']} <- {Path(seg['src']).name}")
        slide_png = work / f"slide-{seg['num']}.png"
        render_slide(seg, slide_png)
        out = assemble(seg, slide_png, ff)
        size_mb = out.stat().st_size / 1_048_876
        print(f"      -> {out}  ({size_mb:.1f} MB)")
    print("done")


if __name__ == "__main__":
    main()
