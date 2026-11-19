# 演示录屏脚本（record_demo.py）

驱动实机 Zotero 逐功能录制演示视频的节点脚本：每个「场景」是一串节点
（bridge 调用 / 鼠标动作 / 等待），配合 ffmpeg gdigrab 全屏录制，产出
`rec/<场景>.mp4`。

## 演示视频产线（build_demo.py）

`docs/demo-*.mp4` 由 `build_demo.py` 从人工录屏素材剪辑而成：

```bash
python scripts/demo/build_demo.py       # 全部四段；传段号如 `1 3` 只重做对应段
```

素材路径写在脚本 `SEGMENTS` 里（Downloads 下的 mp4）。每段自动前置一张
4 秒总结片头（HTML 模板排版 → Edge 无头截图），与录屏单次 ffmpeg 滤镜图
拼接，统一转 1728×1080 / 30fps / H.264 yuv420p + faststart 的无声视频；
素材若是别的分辨率会自动缩放进同一画幅。片头文案（标题/卖点/要点）也
在 `SEGMENTS` 里改。

## 宣传片产线（build_promo.py，配音 + 字幕）

`docs/promo.mp4` 是带解说配音、烧录字幕的完整宣传片（痛点开场 → 引入
插件 → 五个基础功能 → 总结），由 `build_promo.py` 全自动合成：

```bash
python scripts/demo/build_promo.py                 # 全流程（有缓存则快）
python scripts/demo/build_promo.py --voice tide    # 换音色（默认 stella）
python scripts/demo/build_promo.py --no-burn       # 只合成不烧字幕
```

- **配音**：逐句调 DeepSeek `POST /v1/tools/tts`（24kHz PCM，音色
  stella / tide），按句合成以便拿到精确时长——字幕就是按句时刻排的，
  不会重叠；素材句位置（`at` 字段）对齐录屏内容。
- **时间轴**：每段时长 = max(片头需要, 旁白需要)；录屏不够长时冻结末帧
  （tpad clone）补齐。旁白音轨用 wave 模块拼装，句间静音。
- **画面**：开场/总结页（含 qwen-image 生成的配图）+ 章节页（虚拟形象
  `avatar-front.png`，从三视图 character sheet 自动裁正面）+ 五段实机
  录屏。幻灯片 HTML → Edge 无头截图。
- **字幕**：生成 ASS（Microsoft YaHei、白字描边、底部居中），concat 后
  一遍 libass 烧录。
- **BGM**：`promo-assets/bgm-construction.m4a`，取自坎巴拉太空计划
  （KSP）建造大楼（VAB/SPH）配乐（游戏内文件名 Construction01），即
  Kevin MacLeod 的曲子，**CC-BY 授权**——公开发布视频时请在简介里署名
  （如 "Music: Kevin MacLeod (incompetech.com), CC-BY"）。合成时自动循
  环到成片长度（接缝 2.5s 交叉淡化）、首尾淡化、0.15 音量垫底（旁白
  -24dBFS，BGM ≈ -36.5dBFS）。
- **配图**：`promo_gen_images.py` 调本机 qwen-image-2.1（见
  `~/Documents/deepseek-harness/default-workspace/qwen-image-2.1/README.md`；
  一次加载管线出 4 张，参考图用裁好的单人立绘）。注意 qwen venv 的沙箱
  只能写自己工作区，图先落在 `out/promo/`，手动拷到 `promo-assets/` 再
  重跑 build_promo。
- 全程幂等：TTS 按「音色+文本」哈希缓存、幻灯片与分段 .ts 已存在即跳过，
  改了 `SCRIPT` 里的文案后重跑即可增量重建。

## 用法

```bash
python scripts/demo/record_demo.py list        # 列出场景
python scripts/demo/record_demo.py one panel-open        # 录一个场景
python scripts/demo/record_demo.py one refetch result-reveal
```

## 依赖

- Python 3.12+，`pip install pillow pywin32 imageio-ffmpeg`（imageio-ffmpeg 自带 ffmpeg 二进制）
- 运行中的 Zotero + 已装本插件（bridge token 自动从 profile 读取）
- **分辨率敏感**：脚本里的鼠标坐标按 1920×1080、Zotero 最大化标定。
  显示分辨率/缩放变化后需重新标定（对照 UI 元素位置改 SCENES 里的坐标）。

## 节点动作

| 动作 | 说明 |
| --- | --- |
| `wait <秒>` | 等待 |
| `bridge <op> [json]` | POST `/dsh-bridge/<op>`（debug.* 驱动插件） |
| `click <x> <y>` | 物理像素左键单击 |
| `drag <x1> <y1> <x2> <y2>` | 慢速人速拖选（PDF 划词） |
| `wheel <x> <y> <delta>` | 滚轮（正=上 / 负=下，用于展开弹窗译文） |
| `maxwin` | restore→maximize，顺带修 DPI 渲染并置前台 |
| `closewin <标题>` | WM_CLOSE 指定标题窗口 |
| `waititem <id> <秒>` | 轮询条目直到标题不再是「文件名」态（元数据任务完成） |

## 场景清单

`panel-open` 悬浮窗唤醒 → `host-switch` 悬浮窗⇄标签页 → `reader-assist`
阅读器绑定会话 → `translate` / `translate-full` 划词翻译（完整版含添加到
评论）→ `refetch` AI 元数据重取（先手动把条目元数据改烂再录）→
`result-reveal` 恢复后条目面板 → `settings` 设置面板。
