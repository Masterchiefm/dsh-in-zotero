# dsh-in-zotero

把 [DeepSeek Harness（dsh）](https://www.deepseek.com/harness/) 装进 [Zotero](https://www.zotero.org/)：在 Zotero 里直接使用 dsh 的原生会话界面、按文献绑定的阅读助手、划词流式翻译，以及「AI 重新获取元数据」。所有文库改动都通过 Zotero 自己的接口完成，绝不直接读写 `zotero.sqlite`。

[![Latest Release](https://img.shields.io/github/v/release/Masterchiefm/dsh-in-zotero)](https://github.com/Masterchiefm/dsh-in-zotero/releases/latest)
[![Build](https://github.com/Masterchiefm/dsh-in-zotero/actions/workflows/release.yml/badge.svg)](https://github.com/Masterchiefm/dsh-in-zotero/actions/workflows/release.yml)

## 下载安装

### 推荐：让 dsh 的 AI 替你装

1. 先下载安装 [dsh 官方桌面版](https://www.deepseek.com/harness/)，完成登录与模型配置
2. 在 dsh 里新建对话，粘贴下面这段提示词，agent 会自行完成下载与安装的全过程（网络不畅时它会自行尝试代理或加速镜像）：

   ```text
   请全程自动为我安装 Zotero 插件 dsh-in-zotero，不要把安装步骤留给我：
   1) 从 https://github.com/Masterchiefm/dsh-in-zotero/releases/latest 下载最新的 dsh-in-zotero-<版本号>.xpi；
      GitHub 直连失败或太慢时自行尝试系统代理，或改用加速镜像（例如在下载地址前拼接
      https://ghfast.top/ 或 https://gh-proxy.com/ 前缀）重试。
   2) 从 profiles.ini 找到我的 Zotero 默认 profile（Windows 通常在 %APPDATA%\Zotero\Zotero\Profiles，
      macOS/Linux 在 ~/Library/Application Support/Zotero/Zotero/Profiles 或 ~/.zotero/zotero）。
   3) 若 Zotero 正在运行，先帮我退出它；把下载的 xpi 复制为该 profile 下
      extensions/dsh-in-zotero@dsh.local.xpi。
   4) 启动 Zotero，确认插件管理器里出现 dsh-in-zotero，然后把结果告诉我。
   注意：全程不要读写 zotero.sqlite。
   ```

3. agent 报告安装完成后，点文献列表工具栏右侧的 DSH 唤醒按钮即可开始（插件会自动检测桌面版 dsh）

### 手动安装

1. 到 [**Releases**](https://github.com/Masterchiefm/dsh-in-zotero/releases/latest) 下载最新的 `dsh-in-zotero-x.y.z.xpi`
   （国内直连 GitHub 慢时，可用任意 GitHub 加速镜像前缀拼接下载地址；也可从 [Zotero 中文社区插件商店](https://github.com/zotero-chinese/zotero-plugins) 安装）
2. 打开 Zotero → 工具 → 插件 → 右上角齿轮 → **Install Plugin From File…** → 选中下载的 `.xpi`
3. 重启 Zotero

**运行要求**：

- Zotero 7 及以上（在 Zotero 10 上开发测试）
- dsh 桌面版（推荐，自动检测）**或** Node.js ≥ 24.9（无桌面版时用内置运行时自动 npm 安装）
- Zotero 设置 → 高级 → **允许本机其他应用与 Zotero 通信**（默认开启；dsh 的工具回调依赖它。插件启动时会自动检测，发现被关闭会弹窗一键启用，无需重启）
- 已在 dsh 中配置过模型（`~/.dsh/.credentials.yaml`），否则翻译与 AI 功能无法工作（会话窗口本身可用）

## 功能与截图

以下截图均为实机操作（演示文献：Zetsche et al., *Cell* 2015 —— Cpf1/Cas12a 里程碑论文，含真实模型调用与真实写回）。

### DSH 悬浮对话窗

**入口**：文献列表工具栏（「新建条目 / 通过标识符添加条目 / …」按钮组的最后）。

点击弹出**悬浮窗**形态的 dsh 原生对话界面：窗口可拖动/缩放/收起，窄宽度下 dsh 的会话列表自动折叠（页内抽屉可展开）。每次打开都新建并绑定一个 dsh 会话；dsh 只在首次点击时整页加载一次，之后常驻（sidecar 与页面都保活，重复点击秒开、无 loading 闪屏）。

<img src="screenshots/floating-panel.png" width="760" alt="悬浮对话窗">

### 阅读器助手

**入口**：PDF 阅读页工具栏（「外观」按钮左边）。

同一个会话界面，但**每篇文献绑定一个会话**：再次点击回到该文献绑定的会话；在这里新建会话（顶部按钮或 dsh 自带新建）会解绑旧会话并改绑新会话。会话能看到你正在读的这篇文献——提问直接基于当前文献的上下文。下图中红圈为阅读页工具栏的唤醒按钮，输入框里是点划词弹窗「问AI」后自动填入的所选文字（红色箭头处），问题由你补全后自己发送：

<img src="screenshots/reader-assistant.png" width="760" alt="阅读器助手（每篇文献一个绑定会话，含「问AI」自动填入）">

### 划词翻译「译」

**入口**：阅读器划词弹窗。

PDF 里划选文字，弹窗即出现胶囊形「译」按钮，点击流式翻译；旁边的「自动」开关打开后，划选立即流式翻译（下图为自动翻译完成的效果，译文已渲染在弹窗里）。可开启**深度思考模式**（思考内容实时流式显示，结束后自动折叠成一行，可随时展开回看）。

<img src="screenshots/translate-popup.png" width="760" alt="划选即译（自动翻译）">

译文结束后点「添加到评论」，自动在 PDF 上为所选文字落下划线批注、译文写入批注评论（点击批注即可查看引文与译文）：

<img src="screenshots/annotation.png" width="760" alt="一键添加到评论（下划线批注 + 译文）">

行尾的**「问AI」**按钮：把所选文字送进本文绑定会话的输入框（**不发送**，问题由你补全后自己发送）。

### AI 重新获取元数据

**入口**：文献列表右键菜单——「AI 重新获取元数据（DSH）」：

<img src="screenshots/refetch-chat.png" width="760" alt="右键菜单：AI 重新获取元数据（DSH）">

**每条文献一个独立的新会话**（任务历史互不污染），任务消息自带分步操作手册：首选 `zotero_identify` 一步识别权威元数据（读附件首页 → 提取 DOI/arXiv → 联网解析 → 标题比对打分），核对后经 `zotero_update` 写回全部字段（含 shortTitle / abstractNote 维护、条目类型更正），最后按固定格式汇报改动清单。右键「拖进来没识别的 PDF」同样适用——识别后新建正式条目并把原附件挂进去。

写回效果——标题、作者、期刊、卷期页、DOI、摘要、短标题全部补齐（演示前我们刻意清空了这条目的元数据，插件原样找了回来）：

<img src="screenshots/refetch-result.png" width="760" alt="元数据写回后的条目">

### 文库整理与位置感知

**入口**：任意 dsh 会话（不只助手）。

dsh 获得 21 个 `zotero_*` 工具：检索、读全文（真实路径）、改字段/作者/标签、改条目类型、归类移库、建分类、加附件、写笔记、回收站、联网元数据检索、阅读器检索/定位/标注、**列表定位高亮**（新建条目后自动在文献列表中定位并高亮给用户看）……助手还知道你此刻停在哪个分类（含父子层级全路径）：任务与当前分类相关就直接以它为目标，「入库/添加文献」未指明分类时默认归入当前分类，无关则另找——由它按你的问题自行判断。需求超出插件现有能力时，它会主动问你要不要当场为插件开发新功能。

### 设置：翻译模型与 dsh 来源

**入口**：Zotero 设置 → dsh-in-zotero。

划词翻译默认继承 dsh 当前使用的模型，也可从 dsh 已注册的全部模型中手动指定（点「刷新列表」加载）；dsh 来源自动检测本机 dsh 桌面版（含注册表/PATH，检测不到可手动指定安装目录）、npm 内置运行时（自动下载 @deepseek-ai/dsh，开箱即用）或连接已在运行的 dsh 实例（粘贴带 `?token=` 的完整 URL）；自动更新可在此关闭。

<img src="screenshots/settings.png" width="760" alt="设置面板">

### 自动更新

每周自动检查 GitHub Release，发现新版本自动下载安装（GitHub 直连失败时自动走 CDN 镜像），重启 Zotero 生效；也可在设置里关闭，手动从 Releases 页下载。

## 快速上手

1. **配置 dsh**：装了 [dsh 桌面版](https://www.deepseek.com/harness/) 的话插件会自动检测（检测不到时在设置里手动指定安装目录）；没有桌面版就走内置运行时（首次使用自动 `npm install`，需 Node ≥ 24.9）
2. **开始对话**：点文献列表工具栏最右侧的 DSH 唤醒按钮，弹出 dsh 对话窗——像在 dsh 桌面版里一样对话，但它能直接看到你的 Zotero 文库
3. **阅读时提问**：打开一篇 PDF，工具栏「外观」左边会出现唤醒按钮——这里每篇文献有自己的专属会话
4. **划词翻译**：在 PDF 里划选文字，弹窗里点「译」（或打开「自动」开关直接流式翻译）

## 更新

- **自动**：插件每周检查一次 GitHub Release，发现新版本自动下载安装（GitHub 直连失败时自动尝试 CDN 镜像），重启 Zotero 生效。设置里可关闭。
- **手动**：从 [Releases](https://github.com/Masterchiefm/dsh-in-zotero/releases) 下载新 `.xpi` 重复安装步骤即可（设置会保留）。

---

# 开发者文档

## 架构原理

```
┌───────────────────────────── Zotero (主进程) ─────────────────────────────┐
│  dsh-in-zotero 插件                                                        │
│   • 工具栏/阅读器唤醒按钮、右键菜单、划词「译」、会话窗口标签页                  │
│   • /dsh-bridge/* 本地端点（端口 23119，令牌校验）                            │
│       —— 所有读写都用 Zotero 官方 API（saveTx / Attachments.* / …）           │
│   • 子进程管理：spawn `dsh --profile dsh-in-zotero --no-open --port 0`        │
│   • 会话窗口：REMOTE <browser> 内嵌 dsh Web UI（Zotero 拒绝在进程内           │
│     browser 加载 http），Zotero↔页面 通过同源通道通信：                        │
│       导航 = URL 键 #session=<id>；观测 = 页面每 2s POST ui.report            │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ HTTP 127.0.0.1（x-dsh-in-zotero-token）
┌──────────────▼──────────────────── dsh sidecar (Node) ───────────────────┐
│  dsh web（Web UI + JSON-RPC 网关）                                          │
│   • dsh-in-zotero-bridge 插件（host 半区）                                   │
│      - zotero_* agent 工具（21 个）→ 回调 Zotero /dsh-bridge/*              │
│      - /api/zotero/rpc：会话创建/解析/列表、AI 元数据任务、ui.state            │
│      - /api/zotero/translate：NDJSON 流式翻译（用 dsh 自己的模型路由）          │
│      - /api/zotero/models：已注册模型列表（翻译模型选择）                       │
│      - Zotero 工作区会话的系统提示词引导（zoteroGuidance）                     │
│   • client 半区：hash→uiWorkspace.openSession 会话导航 + ui.report 上报      │
└──────────────────────────────────────────────────────────────────────────┘
```

- **会话/凭据共享**：默认使用用户真实的 `~/.dsh`（会话、API Key、模型选择与桌面 dsh 共享），但使用独立 profile `dsh-in-zotero`，不会与正在运行的 dsh 桌面版冲突。可用 `extensions.zotero.dsh-in-zotero.dshHome` 改成独立目录。
- **不阻塞数据库**：dsh 侧的一切写操作都通过 `/dsh-bridge/*` 回到 Zotero 执行；插件从不打开 `zotero.sqlite`。
- **真实路径阅读**：`zotero_read` 返回附件的磁盘真实路径与全文文本（优先 Zotero 自己的全文缓存 `.zotero-ft-cache`，其次 Zotero 的 PDF 文本提取）。
- **会话语义**：文献列表唤醒按钮每次打开都新建会话（可下拉切换/浏览全部）；阅读器按钮为每篇文献绑定一个会话——再次点击回到绑定会话，在 dsh 里新建会话会自动改绑到新会话。

## 从源码构建

```bash
npm run install-runtime   # 把 @deepseek-ai/dsh 装进 .dsh-runtime/（也可让插件首次运行时自动安装）
npm run build             # 产出 dsh-in-zotero.xpi（零 npm 依赖，纯 Node 脚本）
```

发布流程：打 `v*` 标签推送即可，[GitHub Action](.github/workflows/release.yml) 会自动语法检查、构建 `.xpi`、发布 Release，并把新版本写进根目录的 `update.json`（Zotero 原生插件更新器读取的清单）。

## 测试

```bash
npm run check            # 全部 JS 语法检查
npm run test:sidecar     # 离线集成：sidecar 启动 / RPC / 插件路由 / 工具直调（含真实 DOI 联网检索）
node tests/sidecar-live.test.mjs   # 真模型实测：创建会话 + 元数据任务 + 翻译流
node tests/zotero-live.test.mjs    # 对运行中的 Zotero 实测 /dsh-bridge/* 全部端点（含 locate 定位，读写测试条目后清理）
```

`debug.*` 桥端点（token 守卫，随插件发行）可在不碰 GUI 的前提下驱动/观察实机：`debug.open / debug.state / debug.openreader / debug.reader / debug.refetch / debug.update / debug.prefs / debug.cleanup` 等，见 `zotero-plugin/content/scripts/bridge.js` 的 `OPS` 表。

## 偏好设置（Zotero 设置 → dsh-in-zotero；也可 about:config，`extensions.zotero.dsh-in-zotero.*`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dshMode` | `auto` | dsh 来源：`auto`（自动检测）/ `bundled`（内置运行时）/ `attach`（连接已运行实例）；旧值 `desktop`/`custom` 归一化为 `auto` |
| `dshCustomDir` | 空 | auto 模式优先使用的本机 dsh 包目录（须含 `lib/bin.js`） |
| `desktopDir` | 空 | dsh 桌面版安装目录（含 `DeepSeek Harness.exe`）——自动检测不到时手动指定 |
| `attachUrl` | 空 | attach 模式目标实例的完整 URL（含 `?token=…`） |
| `nodePath` | 自动探测 | node.exe 绝对路径 |
| `dshHome` | `%USERPROFILE%\.dsh` | dsh 主目录（会话/凭据共享；设为其他目录即完全隔离） |
| `profileName` | `dsh-in-zotero` | sidecar 使用的 dsh profile |
| `port` | `0`（自动分配） | dsh web 端口 |
| `dshPackageVersion` | `0.2.2-rc.1` | 自动安装的 @deepseek-ai/dsh 版本 |
| `npmRegistry` | npm 默认 | 安装运行时用的 registry |
| `translateEnabled` | `true` | 划词弹窗是否显示「译」 |
| `translateAuto` | `false` | 划选后自动翻译（dsh 已在运行时） |
| `translateThinking` | `false` | 翻译时是否开启思考模式（思考内容流式显示、结束自动折叠） |
| `translateModel` | 空（继承） | 翻译模型，`provider/model`；空 = 跟随 dsh 当前选择 |
| `autoUpdate` | `true` | 每周自动检查并安装更新 |

## 仓库布局

```
.github/workflows/  → Release CI（tag → 构建 → 发布 → 维护 update.json）
zotero-plugin/      → 打包为 .xpi 的 Zotero 插件（bootstrap + chrome 脚本）
dsh-plugin/         → 装进 sidecar profile 的 dsh 插件（host: 工具/路由/提示词；client: 页面桥）
scripts/            → 构建 / 语法检查 / 运行时安装（纯 Node，零依赖）
tests/              → mock Zotero 桥 + 离线/实机测试
AGENTS.md           → 面向 AI 代理/贡献者的实机开发指南（踩坑全集）
update.json         → Zotero 原生插件更新清单（CI 维护）
```

## 致谢

- 提示词与工具形态大量参考 [dsh-zot-library](https://github.com/GenePad/dsh-zot-library)（dsh 的 Zotero 直连文献库插件——本项目把写路径换成 Zotero 官方接口并反向嵌入进 Zotero）。
- [zotero-chinese](https://zotero-chinese.com/plugin-dev-guide/) 的插件开发指南。

## 协议

[MIT](LICENSE) © Masterchiefm
