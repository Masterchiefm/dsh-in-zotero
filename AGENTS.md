# AGENTS.md — dsh-in-zotero 开发指南（面向 agent）

把完整的 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 寄生进 Zotero 的插件：Zotero 内嵌 dsh 原生会话窗口、按文献绑定的阅读助手、划词流式翻译、AI 元数据重取。**所有文库写入都必须经 Zotero 自己的接口——绝不直接读写 `zotero.sqlite`。**

改代码前先读完本文件；这里的"坑"全是实机踩出来的，跳过会重踩。

## 仓库地图

```
zotero-plugin/            → 打包为 .xpi 的 Zotero 插件（bootstrap + chrome 脚本）
  manifest.json             Zotero 10 清单（见下方强制字段！）
  bootstrap.js              注册 chrome://dsh-in-zotero/content/，按依赖序 loadSubScript
  content/scripts/
    util.js                 偏好/日志/路径/HTTP——先加载，其余模块挂全局 DSH.*
    sidecar.js              dsh 来源管理（auto/bundled/attach 三选项；auto 解析出 desktop/custom）+ spawn → token → RPC 客户端
    bridge.js               /dsh-bridge/* 端点（Zotero.Server.Endpoints）+ reader.* 阅读器集成 + debug.* 诊断
    sessionWindow.js        DSH 会话界面：悬浮窗（默认）+ 完整标签页双宿主 + 会话绑定
    translate.js            阅读器划词弹窗的「译」按钮 + 「自动」开关（NDJSON 流式渲染）
    refetch.js              右键「AI重新获取元数据」→ task.refetch 任务分发
    update.js               每周自动检查 GitHub Release → 下载（CDN 兜底）→ Zotero 原生安装
  content/prefsPane.xhtml   Zotero 设置面板（翻译/功能许愿/dsh 来源；prefsPane.js 是其行为脚本，「许愿」按钮走 Zotero.DSHinZotero.openWishSession）
  content/dsh-plugin/       dsh 插件载荷的副本（build-xpi 时从 ../dsh-plugin 复制）
dsh-plugin/               → 装进 sidecar profile 的 dsh 插件（源头，勿改 zotero-plugin 里的副本）
  index.js                  host 半区：工具注册 + /api/zotero 路由 + 系统提示词注入
  client.js                 browser 半区：#session= 导航 + ui.report 上报（见"控制通道"）
  src/tools.js              21 个 zotero_* agent 工具（schema 即文档；zotero_identify 是元数据任务的一步式识别，zotero_locate 在文献列表中定位高亮条目）
  src/prompts.js            助手引导提示词 + 元数据任务操作手册 + 许愿会话开场白（改文案看这里）
  src/sessions.js           Zotero 工作区/助手会话生命周期
  src/translate.js          翻译流（走 dsh 自己的 llm 服务，模型跟随 dsh 当前选择）
scripts/
  build-xpi.mjs             打包 + 校验 PLUGIN_FILES 与 dsh-plugin/ 目录一致（防漂移）
  check.mjs                 全部 JS 语法检查（ESM / chrome 脚本两种目标）
  install-runtime.mjs       把 @deepseek-ai/dsh 装进 .dsh-runtime/
tests/
  mock-zotero.mjs           /dsh-bridge/* 的内存 mock（离线测试 dsh 插件用）
  sidecar.test.mjs          离线集成：sidecar 启动/路由/工具直调/联网 DOI
  sidecar-live.test.mjs     真模型：创建会话+任务+翻译流
  zotero-live.test.mjs      实机全量：全部桥端点 CRUD（自建自删测试条目，含 locate 定位高亮）
```

依赖关系：`zotero-plugin` 在运行时把 `dsh-plugin/` 的文件 fetch 出来 seed 到 profile，所以 **改了 dsh-plugin 必须重跑 `npm run build`**（xpi 里带副本），且 `PLUGIN_FILES`（sidecar.js）与 `PAYLOAD`（build-xpi.mjs）、测试里的文件列表三处要同步增删。

## 构建与测试

```bash
node scripts/check.mjs                 # 语法检查（改完任何 .js 先跑这个）
npm run build                          # 产出 dsh-in-zotero.xpi（自带 zip 校验）
npm run test:sidecar                   # 离线全套（需要 .dsh-runtime 已安装）
node scripts/install-runtime.mjs       # 首次/升级 dsh 运行时（~650 包，约 8 分钟）
node tests/zotero-live.test.mjs        # 实机桥端点（Zotero 必须在跑、插件已装）
node tests/sidecar-live.test.mjs       # 真模型（需要 ~/.dsh 已配置模型）
```

## 发布与自动更新

- **仓库**：<https://github.com/Masterchiefm/dsh-in-zotero>
- **发布**：bump `zotero-plugin/manifest.json` 的 `version`（连同 `dsh-plugin/package.json`、根 `package.json`）→ 提交 → `git tag v<version> && git push origin v<version>`。GitHub Actions（`.github/workflows/release.yml`）自动：语法检查 → 构建 → 发布 Release（`dsh-in-zotero-<version>.xpi`）→ 把新版本 append 进根目录 `update.json` 并提交回 main（Zotero 原生插件更新器读它）。
- **每周自动更新**（`content/scripts/update.js`，DSH.Update）：启动 90s 后若距上次检查 ≥7 天则查 GitHub Releases API；有新版则 toast → 下载（GitHub 直连 → `ghfast.top` → `gh-proxy.com` CDN 前缀逐个 fallback）→ `Zotero.Utilities.Internal.installAddon` 安装，重启生效。pref `autoUpdate`（默认 true）/ `lastUpdateCheck`（内部时间戳）。调试用 `POST /dsh-bridge/debug.update {forceVersion:'0.0.1',install:false}` 强制走更新分支、`{install:true}` 实测下载安装。
- **manifest 的 `update_url`** 必须指向本仓库 main 分支的 `update.json`（现行值已改好），不要用上游 org 的地址。

### 实机迭代循环（改 zotero-plugin 后）

1. `npm run build`
2. 关 Zotero（`taskkill /IM zotero.exe /F`）
3. 复制 xpi 到 profile 并同步版本号（见下方"实机部署片段"）
4. 带 `-ZoteroDebugText` 重启并重定向 stdout/stderr 到日志
5. 用 `debug.*` 桥端点驱动/观察（不用碰 GUI，CUA 在 Zotero 上极不稳）

版本号在 `manifest.json` **必须每次 bump**——profile 里换 xpi 后 `extensions.json` 的 version 也要手改，否则旧代码仍在运行。

### 实机部署片段

```bash
P="$APPDATA\\Zotero\\Zotero\\Profiles\\<profile>"
cp dsh-in-zotero.xpi "$P\\extensions\\dsh-in-zotero@dsh.local.xpi"
# 并把 extensions.json 里 dsh-in-zotero@dsh.local 的 version 改成 manifest 一致
powershell -NoProfile -Command "Start-Process 'C:\Program Files\Zotero\zotero.exe' \
  -ArgumentList '-ZoteroDebugText' -RedirectStandardOutput out.log -RedirectStandardError err.log"
```

## 架构关键决策（不要"简化"掉）

1. **sidecar 进程**：`node dsh/lib/bin.js --profile dsh-in-zotero --no-open --port 0`，stdout 出现 `dsh web: http://127.0.0.1:<port>/?token=...` 即就绪信号。默认共享用户真实 `~/.dsh`（凭据/模型/会话互通）但用独立 profile，不与桌面 dsh 冲突。环境变量传 `DSH_ZOTERO_PORT`/`DSH_ZOTERO_TOKEN`（dsh 插件回调 Zotero 桥用）。**dsh 来源三选项**（`dshMode` pref = `auto`/`bundled`/`attach`，设置面板 menulist；`state.resolvedMode` 记录实际解析出的 `desktop`/`custom`/`bundled`/`attach`）：`auto`（默认解析链：`dshCustomDir` 已填且含 lib/bin.js→`custom`；`findDesktopInstall()` 检测到桌面版→`desktop`；否则 bundled runtime 已装→`bundled`；都没有→`promptSourceChoice` 弹窗三选一）/ `bundled`（npm 装进数据目录，强制忽略桌面版）/ `attach`（`attachUrl` 连已在运行的 dsh web，不 spawn；`probeBridge` 探测桥插件，缺失则 `bridgeOk=false` 降级仅对话——**桌面版实例无法 attach**：其 URL/token 只在桌面 shell 内存里，无落盘发现机制）。`desktop`（**运行桌面版自带引擎**：`spawn(DeepSeek Harness.exe, [<app.asar 内的 dsh>/lib/bin.js, ...])` + 环境变量 `ELECTRON_RUN_AS_NODE=1`——Electron 二进制以 node 模式运行且保留 asar 读取能力，桌面版自己的 Host 子进程就是这个机制；用桌面版自带的 dsh 版本，不再唤起 npm 运行时）与 `custom`（`dshCustomDir` 指向本机 dsh 包）只是 resolvedMode，不再是 pref 选项——旧 pref 值在 `dshMode()` 读取时归一化为 `auto`，行为不变。**与桌面版共存（实机双向验证）**：桌面版运行时本插件引擎照样能 spawn（ready）、本插件引擎运行时桌面版也照常启动——本插件用 `--port 0` 随机端口 + 独立 profile（`~/.dsh/profiles/dsh-in-zotero`），桌面版 Host 用自己的端口与 profile（`desktop`），`~/.dsh` 只共享凭据/模型/会话存档。真正会撞的是**同 profile 双实例**（残留探针/僵尸进程）与同端口 dsh web；EADDRINUSE 提示只在子进程真的绑定失败时触发，文案已改为「端口绑定失败」。同一会话两边同时对话未测——提醒用户避免。
2. **控制通道**（Zotero ↔ 嵌入页）：dsh Web UI 跑在 **remote browser**（见坑 #3），chrome 侧碰不到页面全局。导航 = **hash-only** `#session=<id>`（client.js 的 hash 监听调 `uiWorkspace.openSession`，同文档导航不重载 SPA）；观测 = client.js 每 2s POST `/api/zotero/rpc {op:'ui.report'}`，Zotero 侧轮询 `{op:'ui.state'}` 判断新会话（阅读模式改绑）。**首次整页加载用带 `?token` 的 LAUNCH URL（不带任何 hash），token 在 remote content process 侧一次换票**——新版 dsh 的认证 cookie 是 `dsh-auth-<sha256(host:port)>` + SameSite=Strict：`connectAuth` 在 chrome 侧用 XHR 种的 cookie，跨站顶级导航 chrome://→http://127.0.0.1 时 isolated 内容进程**不会发送**（Strict），裸 URL 必然先 401 闪 "dsh web authentication required"、再空等 `waitForPage` 轮询才兜底（~30s）。用 launch URL 则 dsh 在内容进程内校验 token、就地种 cookie、303→`./`，同站后一切正常。token URL **绝不和 `#hash` 一起挂**（303 会丢 fragment）——hash 一律由 `navigateToSession` 在全页加载后用 fragment-only 导航附加，所以丢 query 无损失。cookie 膨胀由 `connectAuth` 的 `pruneAuthCookies()` 在每次 /connect 前清掉（新版 Gecko `Services.cookies.remove` 是 **4 参 `(host,name,path,originAttributes)`**，已无 isSecure 槽，传 `false` 会 431/ILLEGAL_VALUE）。`ensurePageLoaded`/`navigateToSession`（sessionWindow.js）保证每个 sidecar 生命周期至多一次整页加载。
3. **双宿主**：悬浮窗（默认，position:fixed 面板，可拖动/缩放/收起，几何存 `panelBox` pref）与完整 Zotero 标签页共享**同一个 live 页面**——两个宿主各有一个 remote `<browser>`，切换时 `browser.swapBrowsers()` 搬运会话（tab 关闭的 `onClose` 在容器移除前同步调用，是搬回面板的窗口期；swap 不可用时退化为重新加载）。悬浮窗宽度 <1024px 时 dsh Web UI 自动折叠会话侧栏（dsh-client-ui-layout 的响应式行为），这正是"悬浮窗只显示对话区"的实现，**不需要改 client.js**。关闭悬浮窗只是隐藏，页面与 sidecar 常驻，重复点击秒开。
4. **会话语义**：列表模式每次开新会话；阅读模式每 itemID 绑定一个（存 `extensions.zotero.dsh-in-zotero.bindings` JSON pref），UI 里新建自动改绑。语义在 `sessionWindow.js` 的 `open()`/`startObserving()`。**会话下拉 = Zotero 工作区的活跃会话列表**：`sessionController.list` 是全局的（跨工作区、含已归档），下拉只显示 `zotero && !archived && !blank`（当前会话无条件保留）；`zotero`/`archived` 两个标记由 dsh-plugin 的 listSessions 打（cwd 比对 + `workspaceRegistry.archivedSessionIds`）。**空会话治理**：列表模式占位会话（`Zotero 会话`/`Zotero会话`/`Zotero 文献会话`，历史拼写并存！）不用就堆积——`sweepEmptySessions` 在每次 open/新建时把「Zotero 工作区内 + blank + 未归档 + 占位/无标题 + 未被绑定引用」的残留经 `session.archive` 路由归档（`workspaceRegistry.archiveSession`，dsh 自己的软删除，可从其 UI 恢复；被绑定引用的会话绝不归档）。**标题轮询**：dsh 标题服务在首轮对话后自动改名，观察循环每 6s 比对 `state.current.title`，变了就刷下拉并 `Zotero_Tabs.rename(id, title)` 镜像到标签页标题（该 API 接受显式 title）。**冷启动提示**：`DSH.Sidecar.withColdHint()` 统一给冷启动状态附加「首次启动需加载组件，请多等片刻；之后就快了」——ensureStarted 内部包一层 status()（attach 路径不包，它连的是已在运行的实例），translate 弹窗 / refetch 进度 / strip 状态的初始文案各自调 withColdHint。**标签跟随**：面板可见时（Notifier `tab`/`select` 事件，观察者 id `dsh-in-zotero-tabs`），切到 reader 标签自动跟到该文献绑定会话（无绑定则静默新建并改绑），切回文献列表保留当前会话、仅把上下文重定向为 list 模式（每访问都新建会话会刷爆会话列表）——全程**无 toast**；`setHost` 期间 `suppressFollow` 抑制跟随（关 tab 会触发其他 tab 的 select），`followSeq`/`navSeq` 代际守卫丢弃过期跟随与导航；同哈希导航有快速路径（重复 loadBrowser 同一 hash 不触发 hashchange，轮询只会白等 30s）。
5. **提示词注入（按会话）**：Zotero 侧每次当前会话变化都推 `chat.context {sessionId, mode, itemID, attachmentID, itemTitle, itemMeta, collection}`（itemMeta 含 itemType/creators/date/DOI/abstract 截断；**collection 是分类树当前位置** `{type, id, name, path}`，type ∈ collection/library/group/search/trash/feeds，collection 类型的 path 是「父 / 子」全路径——sessionWindow.js 的 `collectionContext()` 采集，观察循环每 2s 比对签名、变了就重推，`collectionsView`/`collectionTree` 两个属性名都试——本机 Zotero 用旧名），sidecar 按 sessionId 存 `sessionContext` map（`~/.dsh/dsh-in-zotero-bridge-state.json`，上限 50 条 LRU）；systemPrompt section（order 4800）用 `assembly.agent.session.id` 查 map——**没有记录的会话（元数据任务、子代理）只拿通用指引，绝不继承别的会话的「用户正在看《X》」**（v2 全局 chatContext 的教训）。guidance 含 21 个 zotero_* 工具速览 + 原有工作流规则（改动保守）；list 模式把分类整段说明渲染出来（**任务可能与该分类相关、也可能无关，agent 按问题措辞判断**；入库且未指明分类时默认归入当前分类），reader/item 模式只留一句默认归类规则。**入库策略（guidance 明文）**：条目 + 链接（DOI/url 字段）就是完整交付物，建好即 `zotero_locate` 定位高亮给用户看；**默认不找 PDF 附件**，用户明确要附件才全力尝试（OA 下载 → `zotero_attach {path}`；拿不到 → 挂 url 链接附件并如实说明）。`locate` 桥端点：先 `Zotero_Tabs.select('zotero-pane')` 把文献列表带到前台 → 轮询 `itemsView._rowMap` 等新建条目行刷进来（防 selectItem 的「找不到就切库根」兜底误触发）→ `CollectionTree.selectItem(id)`（当前视图选中；回收站回退；库根回退；附件 id 自动定位父条目）。
6. **翻译**：Zotero chrome → sidecar `/api/zotero/translate`（NDJSON 流）→ dsh llm 服务。XMLHttpRequest onprogress 增量解析；弹窗销毁时停止流。等待期只显示 CSS spinner（无「正在连接」文案）；「自动」开关（`translateAuto` pref）在 dsh 已就绪时划选即翻——**故意不在 sidecar 未启动时自动触发**，避免划词偷偷拉起 node。
7. **元数据任务（每任务一个新会话）**：`task.refetch` 对**每个条目**各建一个全新会话（标题 `元数据重取 · <题名>`），没有也不再有常驻助手会话——任务历史绝不互相污染；只有阅读模式才做文献↔会话绑定。两类目标：普通条目原地 update 写回；**独立附件**（拖进库没识别的 PDF，refetch.js 打 `standalone` 标记）走 `zotero_add {…, adoptAttachmentIDs:[附件id]}` 新建正式条目并挂接原附件（bridge 的 add op 先 pre-flight 校验再建条目，挂接 = 设 `att.parentKey`，新条目**继承附件所在分类**、附件自身退出分类——复刻 Zotero 原生拖 PDF 识别行为；绝不用 attach 重新导入文件，会复制出第二份）。任务消息是 prompts.js 的 `refetchTaskMessage(item)`：自包含的分步操作手册（identify 优先 → 回退 lookup → 核对 → 写回/建条目挂接 → 汇报格式），字段格式规则（date/pages/DOI/creators）都写在手册里，agent 无需试错。**面向用户的表述一律用题名/文件名/分类名，数字 id 只许出现在工具参数里**——guidance 与任务手册都有明文（「条目 1694」对人类无意义）。`zotero_identify` 工具内聚了「条目现状 + 附件首页 → 标识符提取 → Crossref/doi.org/OpenAlex/arXiv/PubMed 解析 → 标题比对打分」，返回可直接写回的 draft；id 也可直接给独立附件。
8. **阅读器集成（bridge.js 的 reader.*）**：搜索/定位/标记走**打开的 reader**（`Zotero.Reader._readers` 按 itemID=附件 id 找；没有可自动 `Zotero.Reader.open`）。内部视图 `_internalReader._primaryView` 是 pdf_view：`_pdfPages[i].chars`（逐字符 + inlineRect，PDF 页面坐标 y-up scale1）、`_ensureBasicPageData(i)` 按需载页；文本匹配要在「空白折叠」的规范化文本上做（chars 有 spaceAfter/lineBreakAfter/paragraphBreakAfter/ignorable 标志），命中 char 切片 → rects（按行 union，lineBreakAfter 分行）→ 直接塞进 `Zotero.Annotations.saveFromJSON`（key 用 generateObjectKey，sortIndex 复刻 reader 的 getSortIndex 即可，仅影响侧栏排序），打开的 reader 经 Notifier **实时显示**新批注。跳转 `reader.navigate({position:{pageIndex,rects}})` 走基类会顺带 setSpotlight 闪光（纯页跳转用 `{pageIndex}`，跳已存批注用 `{annotationID}`）。**颜色必须落 Zotero 8 色批注色板**（`Zotero.Annotations.COLORS`），任意色按 RGB 最近吸附。reader 工具 trio：`zotero_reader_search`（拿页码+原文）→ `zotero_reader_locate`（跳转+可选 mark）→ `zotero_reader_annotate`（不跳转的标记）；笔记全文读取走 `notes` op（zotero_notes）。

## 实机踩过的坑（每条都花过 30 分钟以上）

1. **manifest 必须 `applications.zotero.update_url`**：Zotero 10 的 `Extension.sys.mjs` 对缺失 `update_url`/`strict_max_version`/`id` 直接判 invalid，安装报"可能不兼容"。报错原文在 Browser Console：`addons.webextension.<id> ERROR Reading manifest: ...`。
2. **`PathUtils.join` 拒绝含 `/` 的段**（如 `'src/tools.js'`）→ `NS_ERROR_FILE_UNRECOGNIZED_PATH`。`DSH.Util.joinPath` 已做分段，新代码一律用它。
3. **Zotero 主窗口进程内 `<browser>` 静默拒绝加载 http(s)**（src 属性/fixupAndLoadURIString 都是无声 no-op，`resource://`/`about:` 正常）。会话窗口必须 `remote="true"` 的 browser。诊断时 `browser.currentURI.spec` 停在 about:blank + 无任何网络请求即中此坑。
4. **未知 tab 类型写入 session.json 会让下次启动 restoreState 抛错**（`Zotero_Tabs.restoreState` 解构缺失 hook 的返回值）。已在 `ensureTab` 里 patch `Zotero_Tabs.getState` 过滤本插件 tab，另注册了 `restoreState.dsh` no-op hook 双保险。别把 TAB_TYPE 改成别的又不处理这两处。
5. **`Zotero_Tabs.add` 必须传 `data: {}`**，否则 `_update` 读 `tab.data.icon` 抛错。
6. **`onMainWindowLoad` 只对插件启动后新开的窗口触发**——已存在的窗口要在 `onStartup` 里用 `Zotero.getMainWindows()` 手动补接线。
7. **dsh 侧 profile bundle 的包必须声明 `dsh.bundle.patch`**（cordis.patch.yml 指回自身）+ `exports["./client"]`，缺一个就 `declares no dsh.bundle` / `exports no "./client"` 启动失败。
8. **dsh web 的 unary `POST /api/<method>` 通道在 0.2.2-rc 未挂载**（浏览器走 WS mux）——Zotero chrome 一律用插件自有路由 `/api/zotero/rpc`，别试图直调 `session.list` 等网关方法。
9. **进度窗口 `changeHeadline` 的图标参数是 cssIconKey 不是 URL**——只传文字。
10. **GUI 自动化（CUA）在 Zotero 上基本不可用**（树重渲染使元素失效、独立窗口无输入关联）。一律用 `debug.*` 桥端点 + `-ZoteroDebugText` 日志验证。
11. **插件 sandbox 里没有裸 `setTimeout`**——引用它会 ReferenceError 且可能逃出外层 try/catch 炸掉整个 onStartup。延时一律用 `Zotero.Promise.delay` 或 window 的 setTimeout。
12. **`Zotero.PreferencePanes` 在插件 startup 时刻可能尚未定义**——注册设置面板要「尝试 + 轮询重试」（`DSH.UI.ensurePrefsPane`）；面板 src 按 XHTML 片段解析，**内联 `<script>` 不会执行**，行为脚本必须走 register 的 `scripts: []` 选项。
13. **设置面板片段绝不能带 `<?xml?>` 声明**：Zotero 把 pane src 当片段嵌进自己的包装文档解析（`defaultXUL:true` 走 `MozXULElement.parseXULToFragment`，包装在 `<box xmlns=xul xmlns:html=xhtml>` 里），文档中部的 XML 声明会让解析抛 `not well-formed XML`（只出现在 stderr/err.log），面板整页空白且无 UI 提示。片段直接裸写 XUL（`html:` 前缀用 HTML），注册时带 `defaultXUL: true`。验证用 `debug.prefs` 桥端点（开窗 + 检查渲染），窗口类型是 `zotero:pref`。
14. **`loadBrowser` 绝不设置 `<browser>` 的 src 属性**——src 变更会触发整页加载（hash 切换必须走 `fixupAndLoadURIString` 的同文档导航），这是「只加载一次」特性的关键之一。
15. **`taskkill /F` 杀 Zotero 会孤儿化 sidecar node 进程**——下次重启后插件可能连上**旧代码**的孤儿 sidecar，症状是「改了 dsh-plugin 却不生效」（每轮 taskkill 迭代累积一个，实机曾积到 12 个）。实机部署循环要先清 node：`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -like '*dsh-in-zotero*'} | ... Stop-Process`。判断连的是哪个 sidecar：看 `~/.dsh/dsh-in-zotero-bridge-state.json` 的写入者版本特征。
16. **`Item.getAnnotations()` 默认返回条目对象数组且需要 childItems 已加载**——旧 bridge 按返回值当 id 用导致 `zotero_annotations` 永远返回空。正确姿势：`await item.loadDataType('childItems')` 后用 `getAnnotations(false, true)` 拿 id。批注颜色只接受 `Zotero.Annotations.COLORS` 的 8 色色板，其他 hex 抛 `Invalid annotation color`。
17. **reader 内部视图的 `_pagesCount` 在 SDTView 上、pdf_view 没有**；数页数用 `view._iframeWindow.PDFViewerApplication.pdfDocument.numPages`。reader iframe（resource://）是特权页面**没有 X-ray**——直接访问 expando 属性即可，套 `wrappedJSObject` 反而拿不到。自动打开 PDF 后文档异步初始化，操作前要轮询页数就绪（findInReader 已内置）。

21. **Windows junction/符号链接清理的三重坑**（卸载 dsh-runtime 时实测）：① Git Bash 的 `ln -s` 对目录建的是 NTFS **junction**；② node 的 `fs.rmSync` 对 junction 会**静默假成功**（返回 ok 但链接还在）——删 junction 要用 `fs.rmdirSync`（对非空真实目录会拒绝，语义天然安全），文件型符号链接才用 rmSync；③ `IOUtils.exists` 穿透链接，**悬空链接恒报 false**——删完不能用它验证，要用 node lstat 探针（sidecar.js 的 linkInfo/removeLink）。nsIFile.isSymlink() 也认不出 MSYS 建的 junction。清理功能（debug.cleanup / 设置面板「卸载本插件安装的 dsh」）递归删除真实目录没问题，但遇到链接必须走 removeLink，绝不能 IOUtils.remove(recursive) 穿透（会删掉链接目标的内容）。
18. **会话标题在 `summary.projections.values.title`**，不是 `projections.projectionValues`（后者不存在）——读错键时列表全空、下拉全变「未命名会话 M-D HH:MM」。`sessionTitle.rename` 本身是好的；空白（blank）且无题名的会话在下拉里要过滤（保留当前会话），否则标签跟随建的一堆未用会话会刷屏。
19. **`npx asar extract-file <asar> package.json` 会把包内文件解到 CWD 并同名覆盖**——曾把桌面版的 package.json 解进仓库根、随后 `rm` 把仓库自己的 package.json 连带删掉。反编译/提取一律先 `cd` 到临时目录。
20. **验证用的一次性探针进程要记杀**——后台 `&` 启动的引擎探针（node/Electron-as-node）不会随脚本退出而死，会以同 profile 僵尸共存，污染后续验证（甚至双实例同 profile）。探针脚本结束前显式 kill 并清理临时 profile。
22. **`~/.dsh/storages/workspace.json` 是全局共享且各引擎各自缓存**——本插件引擎与桌面版同时运行时，`workspaceRegistry.archiveSession` 在插件引擎内存里生效并返回 ok，但落盘会被桌面版的下一次 flush 回滚（实测归档 238 条只落住 60 条）。清扫因此设计成幂等：每次 open/新建重扫 `session.list` 里的 blank 占位残留，桌面版关闭后自然收敛；`sessionController.list` 是全局的（含已归档、跨工作区），行上的 `zotero` 标记（dsh-plugin listSessions 按 cwd 打）与 `blank` 过滤缺一不可。验证 archive 路由用临时 `DSH_HOME` + 桌面 asar 引擎（`ELECTRON_RUN_AS_NODE=1 DeepSeek Harness.exe <app.asar>\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile <临时> --no-open --port 0`），别碰真实 `~/.dsh`。
23. **pref 有两套命名空间，设置面板与运行时曾各写各的（0.8.6 修复；0.1.15 补后半课）**——Zotero 面板的 `preference` 绑定走 `Zotero.Prefs.get(name, true)`（名字原样使用），面板 XHTML 里写 `extensions.zotero.dsh-in-zotero.*`；而 util.js 的 prefGet/prefSet 曾用裸 `dsh-in-zotero.*`——面板上勾的 translateThinking 运行时根本读不到。已统一到 `extensions.zotero.dsh-in-zotero.*`（prefs.js 默认值所在分支），prefGet 对旧分支做惰性迁移。**迁移判断必须用 `Services.prefs.prefHasUserValue`**：prefs.js 声明的默认值会让 `getValue` 回落默认值（非 undefined），仅凭「读到值」判断会永远跳过迁移（translateAuto/panelBox 实测中招）。**0.1.15 的后半课（「自动翻译关不掉」实弹定位）**：把 pref 写成与其默认值相同的值时 **Gecko 会清掉用户值**（`setBoolPref` 成功、`getBoolPref` 读回 false、但 `prefHasUserValue` 变 false——用 debug.reader 的 `atomic:true` 探针实测）；于是下一次 prefGet 的迁移分支把旧分支的陈值（`dsh-in-zotero.translateAuto=true`）**复活**回 canonical——「迁移」必须**消费**遗留值（`clearUserPref`），canonical 已有用户值时也要立即消费遗留副本，否则等于-default 的写入永远被弹回旧值（划词弹窗「自动」开关点关后弹回「开」就是这个）。另外 Zotero reader 的划词弹窗：每次 `append()` 都会被包进带 `border-top` 的 `<div class="section">`（多条横线的来源，只 append 一次并清 wrapper 样式），且 `.selection-popup` 有 `max-width:198px` 的硬上限（自动加宽要一并抬高祖先的 max-width）。**弹窗插件区是 React 组件（reader.js 的 CustomSections，useEffect 无依赖数组）**：每次 React 提交都会 `replaceChildren()` 清空插件节点并重新派发 `renderTextSelectionPopup`——selection-popup 打开时**滚动 PDF 必然触发**（scroll 监听更新 rect → state → 重渲染）。监听器必须幂等：按选区文本区分「重渲染」与「新选区」，重渲染时把活着的 section 原样重新挂载（流继续写入已重挂载的节点），绝不中止重启请求；点击类交互也可能被 mid-click 的重建吞掉，churn 越少越可靠。
24. **dsh 插件注册 agent 工具的三重坑——zotero_* 曾全灭、agent 只会报 "unknown tool"（0.8.11 修复）**：① `ctx.inject(['tools'], cb)` 是「启动一个等待 `tools` **服务组**的子插件」——引擎从不 provide 这个服务组，fiber 永久挂起且**静默**（路由/提示词注入不受影响，于是只有工具消失，极难察觉）。正解照抄引擎自带 dsh-tool-cordis：manifest `export const inject` 里加 `'tools'`，apply 里直接 `ctx.tools.register(...)`（register 返回 disposer，并会对 `output.schema` 抛 `assertSupportedJsonSchema`）。② 引擎强制 JSON Schema 子集（dsh-tools/lib/types/json-schema.js）：`type` 必须是 object/array/string/number/integer/boolean/null 之一，关键字白名单（type/oneOf/properties/required/additionalProperties/items/enum/const + 注解 description/title/default/examples），**放错或多余即拒**；`output: { schema: { type: 'json' } }` 会让 register 全灭（"schema.type must be one of…"），无约束输出用**仅注解** schema（如 `{ description: '…' }`）。③ 引擎日志黑洞：bundle 加载/激活失败只打 `dsh: warning: N entry did not activate` 到 **stderr**（含 import 失败堆栈），而 sidecar.js 只解析 ready 行、丢弃其余 stdout/stderr，Zotero debug 日志里什么都看不到——诊断时用临时 profile（拷真实 profile + 换 payload）+ `ELECTRON_RUN_AS_NODE=1` 桌面引擎直启并完整捕获输出，或在 payload 里临时注入写文件日志。task.refetch 是可从 HTTP 驱动的进程内 agent 通道（`/api/session.prompt` 未挂 HTTP 路由，`/api/session.page` 有）；会话存档 `~/.dsh/sessions/<cwd-key>/<id>/session.v4.jsonl.zstd` 里 `request/header` 的 `header.tools` 数组是该 turn 实际到达 agent 的工具清单，是判定「工具有没有到」的黄金证据。
25. **桌面版检测与首启对话框（0.8.12 修复）**：`findDesktopInstall` 只覆盖 `%LOCALAPPDATA%\Programs` 默认位置 + 注册表 Uninstall 的 DisplayName **严格匹配 "deepseek harness" 两词**——便携版/非默认盘/DisplayName 变体（如 `DeepSeek-Harness`）全漏。现改为 desktopDir pref 手动指定最优先 + DisplayName/UninstallString/key 名宽松匹配 `/deepseek/i` + 从 UninstallString 推目录 + %ProgramFiles% 候选 + `Subprocess.pathSearch` PATH 搜索。**`Services.prompt.select` 在当前 Gecko 的 JS 签名不含 count 参数**（xpconnect 隐藏了 size_is 计数）——多传 `choices.length` 会落到数组参数槽，抛 "Cannot convert primitive JavaScript value into an array arg 3 [nsIPromptService.select]"，首启选源对话框直接崩；用 4 参形态优先、6 参形态 catch 兜底。

26. **新版 dsh 认证 cookie 的两连坑（0.1.4 修复）**：① **首次整页加载必须用带 `?token` 的 launch URL，不能用裸 URL**——新版 dsh 的 cookie 是 `dsh-auth-<sha256(host:port)>` + `SameSite=Strict`，`connectAuth` 在 chrome 侧 XHR 种的 cookie，在 isolated 内容进程发起的跨站顶级导航（chrome://→http://127.0.0.1）里不会发送，裸 URL 必然 401 闪 "dsh web authentication required" 并空等 `waitForPage`（实机 ~26-30s）才兜底。launch URL 让 dsh 在内容进程内校验 token→种 cookie→303 到 `./`。token URL 不带 hash（303 丢 fragment），hash 由 `navigateToSession` 事后 fragment-only 附加。② **cookie 累积触发 431**：dsh 用随机端口，cookie 名按 `host:port` 哈希，每次唤醒换端口 = 新 cookie 名，旧的永不复用 → Cookie 头涨过 16KB → dsh 对 `/connect` 自身也回 431，插件无法自愈。解法是 `connectAuth` 每次 /connect 前 `pruneAuthCookies()` 清空 dsh-auth-*。**新版 Gecko（Zotero 8）`Services.cookies.remove` 是 4 参 `(host,name,path,originAttributes)`**，旧 5 参的 isSecure 槽已不存在，传 `false` 会 `NS_ERROR_ILLEGAL_VALUE`（实机所有删除都失败、prune 形同虚设）；从 Zotero 自带 omni.ja 的 `chrome/remote/content/cdp/domains/parent/Network.sys.mjs` 可核对签名。
27. **`nsIFilePicker.init` 首参在 Gecko 128+/Zotero 8 变成 BrowsingContext，不再是 window（0.1.9 修复）**：设置面板/首启的「浏览…」目录按钮点不动（静默无反应），日志是 `Could not convert JavaScript argument arg 0 [nsIFilePicker.init]`——`fp.init(window, title, mode)` 的 window 被拒。正解 `fp.init(window.browsingContext, title, mode)`（Zotero 自带 `chrome/pippki/content/pippki/certManager.js` 就是 `fp.init(window.browsingContext, …)`）。注意这跟 sandbox 无关：跨 sandbox 传 window、或改在主 sandbox 用 `Zotero.getMainWindow()` 都照样报 arg 0，只有 browsingContext 行。设置面板 sandbox 里 `window.browsingContext` 可直接用；首启路径主 sandbox 用 `Zotero.getMainWindow().browsingContext`。**验证 filepicker 是否真弹出**的可靠办法：脚本派发按钮 `command` 事件（原生模态无法脚本点击）+ Python ctypes `EnumWindows` 捕捉类名 `#32770`、标题含按钮文案的窗口，验证后 `PostMessageW(WM_CLOSE)` 关掉——比看日志/看 UI 线程阻塞靠谱（HTTP server 在独立线程，UI 模态不阻塞 curl）。

28. **`nsIWindowsRegKey.open()` 是 void 方法——注册表检测曾在所有机器上静默死代码（0.1.10 修复）**：IDL 里 `open()` 原地打开接收者、无返回值，`key = rk.open(...)` 把 `undefined` 赋给 key，下一行 `key.childCount` 立即 TypeError，被外层 catch 吞成一行 `registry desktop sweep failed`。症状：另一台电脑装在 `D:\Programs\dsh`（注册表是唯一能发现它的通道、DeepSeek 项就在枚举第 0 位）却报「未检测到 dsh」。正解：**语句式 `rk.open(...)` 后直接用 rk 本身**（与 Zotero 自带 WindowsLaunchOnLogin.sys.mjs 的用法一致，可拿它裁决）；`readStringValue` 对缺失值抛 NS_ERROR_FILE_NOT_FOUND——逐值 try/catch（`regString`），否则任何一个无 DisplayName 的卸载项都会中断整个枚举（本机 HKCU 就有）；electron-builder 的 NSIS 是 32 位进程，每机器安装项落在 WOW64 视图，需显式补扫 `HKLM\Software\WOW6432Node\...\Uninstall`。验证：`debug.detect` 看 `detect.candidates`（origin=registry）与日志 `registry sweep: N entries scanned`；自测法：临时加一个 DisplayName 含 DeepSeek、InstallLocation 指向含假 exe 临时目录的 HKCU 卸载项，验证后删除。

29. **桌面版引擎要「验证 asar」而不是「拼接路径」，工具链用 dsh-runtimes 兜底（0.1.10）**：① `app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js` 在真实文件系统上不存在（asar 内部路径 `IOUtils.exists` 恒 false），Electron-as-node 能读 ≠ 插件能验证。`asarFiles()` 解析 asar 头（u32@0=4 常量、u32@12=JSON 长度、正文在偏移 16，带一项 mtime+size 缓存——头有 ~6MB）后走 `files` 树确认引擎在不在；**对 asar 头做字符串 grep 会误判**——JSON 内键序任意，`"@deepseek-ai":{"files":{"dsh"` 这类模式靠不住，曾据此误判桌面版 44.7.0「asar 里没有 dsh 包」，实际 `/dsh/node_modules/@deepseek-ai/` 下 200+ 个 dsh-* 包俱全（含 dsh/lib/bin.js）。② `asarHas` 的游走起点必须与 `asarFiles` 返回值同层（根节点 `{files}` vs files 映射差一层 `.files`；不一致时恒 false 且**无任何日志**，首次实机 `engineOk:false` 就是它）。③ 引擎验证失败时 auto 链降级 bundled/prompt，不再 spawn 后才「dsh 进程提前退出」；`hasReadySource` 同样要求引擎可用，避免预热空启动。④ dsh 桌面版自带托管工具链 `~/.dsh/dsh-runtimes/<name>/dependencies/{node,pnpm,python}`（runtime.json 记版本）：该 node 是**无 npm 的裸 node**（node_modules 只有 README），`ensureRuntime` 的 npm 兜底走同目录 `pnpm/pnpm.cjs`（`node pnpm.cjs --dir <runtimeDir> add @deepseek-ai/dsh@…`，pnpm 无 --prefix 概念，其符号链接布局 pathExists/node 都能穿透）；`nodePath()` 亦纳入该 node 候选——无系统 Node 的机器 bundled 模式照样能装能跑。

## debug.* 诊断端点（token 守卫，随插件发行）

`POST http://127.0.0.1:23119/dsh-bridge/<op>`，头 `x-dsh-in-zotero-token: <profile>/dsh-in-zotero/bridge-token 的内容>`：

- `debug.open {mode:'list'|'reader', itemID, host?:'panel'|'tab'}` — 等价点击唤醒按钮（host 可强制宿主）
- `debug.state` — sidecar 阶段/dshMode/bridgeOk/宿主/悬浮窗可见性/当前会话/嵌入页 URI/ui 上报新鲜度
- `debug.detect` — dsh 来源检测全套内部状态：候选路径+来源标签（manual/default/registry/path）、注册表扫描条数、桌面版 asar 引擎验证（binJs/engineVia/engineOk）、node 路径。「检测不到 dsh」类报告的远程诊断入口
- `debug.openreader {itemID}` / `debug.reader {dispatchPopup?, clickTranslate?, text?}` — 开阅读器、验工具栏按钮、跑端到端翻译流
- `debug.refetch {items:[id]}` — 跑 AI 元数据重取
- `debug.nav / debug.navremote` — 嵌入 browser 导航探针

## 约定

- Zotero 侧脚本共享一个 sandbox：bootstrap 只建 `ctx`（并 `ctx.ctx = ctx`，因为子脚本看得到目标属性、看不到绑定本身）；`DSH` 全局对象由 util.js 首行 `var DSH = {}` 创建，后续模块挂 `DSH.<Name>`（Util/Sidecar/Bridge/Translate/Refetch/SessionWindow/UI，按加载序）。新脚本要同时加进 bootstrap.js 的加载与卸载两个列表。
- dsh 插件保持零依赖 ESM（Node ≥24.9）；工具返回值过 `lossless()`（harness 拒绝 undefined/function/symbol/BigInt）。
- 中文优先：所有 UI 文案与提示词中文；代码注释中英混排可接受。
- 提示词/工具 schema 的措辞（shortTitle 10~20 字、abstractNote 忠实原文等策略）来自 dsh-zot-library 的成熟实践，改动要保守。
- 仓库根 `package.json` 无运行时依赖；构建/测试只用 Node 内置 + esbuild-free 的自写 zip。
