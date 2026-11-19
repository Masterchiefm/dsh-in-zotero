#!/usr/bin/env python3
"""宣传片配图批量生成：复用 qwen-image-2.1 工作区的 gen_turbo 管线。

一次加载模型（~2 分钟），连续生成 4 张 1024×1024 插画（虚拟形象出场，
深蓝底色 #0F1420 与片头图无缝融合）。用本机 qwen-image venv 运行：

    "C:\\Users\\moqiq\\Documents\\deepseek-harness\\default-workspace\\
    qwen-image-2.1\\venv\\Scripts\\python.exe" scripts/demo/promo_gen_images.py
"""

import os
import sys
import time
from pathlib import Path

WS = r"C:\Users\moqiq\Documents\deepseek-harness\default-workspace\qwen-image-2.1"
sys.path.insert(0, os.path.join(WS, "scripts"))
os.environ.setdefault("HF_HOME", os.path.join(WS, "cache", "hf"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

OUT_DIR = Path(WS) / "out" / "promo"   # qwen venv 沙箱只能写自己工作区；生成后手动拷回仓库
AVATAR = Path(__file__).resolve().parent / "promo-assets" / "avatar-front.png"

CHARACTER = (
    "保留参考图中的Q版女孩角色形象：深蓝色长发、蓝白色鲸鱼造型帽子、"
    "蓝白冬装、大眼睛，三头身Q版比例。画面里只出现这一个角色，不要三视图、"
    "不要多个角度、不要复制角色。"
)
STYLE = "扁平卡通插画风格，干净构图，纯深蓝色背景（#0F1420），蓝紫色光效，无任何文字。"

JOBS = [
    {
        "out": "ill-chaos.png",
        "seed": 11,
        "prompt": CHARACTER
        + "她被几十个漂浮的灰色软件窗口、拼图碎块和齿轮团团围住，"
          "手忙脚乱、头顶冒出汗滴和问号，不知所措。" + STYLE,
    },
    {
        "out": "ill-hero.png",
        "seed": 22,
        "prompt": CHARACTER
        + "她自信地站立摆出超级英雄姿势，披着淡蓝色披风，"
          "身边环绕一圈发光的蓝色工具图标：放大镜、对话气泡、文件夹、标签、魔法棒，"
          "胸前有一枚发光的红色字母Z徽章。" + STYLE,
    },
    {
        "out": "ill-wish.png",
        "seed": 33,
        "prompt": CHARACTER
        + "她踮起脚伸出手，接住一颗从天上落下的巨大发光星星，"
          "星星周围有魔法光点和一张展开的蓝图卷轴。" + STYLE,
    },
    {
        "out": "ill-final.png",
        "seed": 44,
        "prompt": CHARACTER
        + "她开心地挥手庆祝，身边有两只微笑的蓝色小鲸鱼伙伴，"
          "周围飘着彩色纸屑和星星。" + STYLE,
    },
]


def main() -> None:
    import torch
    import gen_turbo

    from diffusers.utils import load_image

    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    todo = [j for j in JOBS if not (OUT_DIR / j["out"]).exists()]
    if not todo:
        print("all illustrations exist, nothing to do")
        return

    t0 = time.time()
    root = gen_turbo.ensure_snapshot("Qwen/Qwen-Image-2.1-Turbo")
    pipe = gen_turbo.build_pipe(root, "nf4")
    print(f"[time] setup {time.time() - t0:.1f}s", flush=True)

    ref = load_image(str(AVATAR)).convert("RGBA")
    for j in todo:
        t1 = time.time()
        out = OUT_DIR / j["out"]
        image = pipe(
            prompt=j["prompt"],
            image=ref,
            width=1024,
            height=1024,
            generator=torch.Generator("cpu").manual_seed(j["seed"]),
        ).images[0]
        image.save(out)
        torch.cuda.empty_cache()   # 释放碎片化的保留显存，给下一张留出峰值空间
        print(f"[done] {out}  ({time.time() - t1:.0f}s)", flush=True)


if __name__ == "__main__":
    main()
