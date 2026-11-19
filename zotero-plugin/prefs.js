// Default preferences for dsh-in-zotero.
// The branch is `extensions.zotero.dsh-in-zotero.*` (Zotero prefixes prefs.js
// entries with extensions.zotero. — matching how other plugins ship defaults).

// --- sidecar (the embedded dsh web server) ---------------------------------
// Where dsh comes from (the settings-pane menulist):
//   auto    = detect: the configured local dsh package dir (dshCustomDir,
//             when filled and valid) → the installed dsh desktop app's own
//             engine → the bundled npm runtime; ask once via dialog if none;
//   bundled = always run the plugin-managed @deepseek-ai/dsh, ignoring the
//             desktop install;
//   attach  = don't spawn anything — connect to an already-running dsh web
//             instance via its attachUrl.
// Legacy 'desktop'/'custom' values normalize to 'auto' on read (the auto
// chain resolves them identically — see sidecar.js dshMode/resolveAutoMode).
pref("extensions.zotero.dsh-in-zotero.dshMode", "auto");
// auto 模式的可选本地 dsh 包目录（须含 lib/bin.js，例如全局 npm 的
// node_modules/@deepseek-ai/dsh）。填写且有效时优先于桌面版与内置运行时；
// 失效时自动跳过。仍使用插件自己的 profile，桥接功能完整。
pref("extensions.zotero.dsh-in-zotero.dshCustomDir", "");
// attach 模式：目标实例的完整 URL（含 ?token=…，从其浏览器地址栏复制）。
// 目标实例需装有 dsh-in-zotero-bridge 才有翻译/文献工具，否则仅对话。
pref("extensions.zotero.dsh-in-zotero.attachUrl", "");
// Empty = auto-detect node.exe on PATH (Subprocess.pathSearch) or common
// install locations. Set to an absolute node.exe path to override.
pref("extensions.zotero.dsh-in-zotero.nodePath", "");
// Empty = use the user's real dsh home (%USERPROFILE%\.dsh) so sessions,
// credentials and model choices are shared with a desktop dsh install.
// Set to an absolute directory to isolate the embedded instance instead.
pref("extensions.zotero.dsh-in-zotero.dshHome", "");
// The dsh profile the sidecar boots. Kept separate from the user's `web`
// profile so a concurrently running desktop dsh is never disturbed.
pref("extensions.zotero.dsh-in-zotero.profileName", "dsh-in-zotero");
// Port for the dsh web server. 0 = pick a free port automatically (the
// authenticated URL is parsed from the server's stdout).
pref("extensions.zotero.dsh-in-zotero.port", 0);
// Version of @deepseek-ai/dsh installed into the runtime directory on first
// use. Pinned so the tested combination ships.
pref("extensions.zotero.dsh-in-zotero.dshPackageVersion", "0.2.2-rc.1");
// npm registry used when auto-installing the runtime (empty = npm default).
pref("extensions.zotero.dsh-in-zotero.npmRegistry", "");

// --- behaviour --------------------------------------------------------------
// Keep the sidecar running after the last dsh surface closes (translations and
// metadata tasks still use it). It is always stopped when Zotero exits.
pref("extensions.zotero.dsh-in-zotero.keepRunning", true);
// Pre-warm the sidecar a few seconds after Zotero starts, in the background.
// Turns the multi-second engine boot into zero perceived latency when the user
// first clicks the wake button or selects text to translate. Skipped on a
// first run that still needs a source-choice dialog, and when keepRunning is
// off (no point booting an instance that would be torn down immediately).
pref("extensions.zotero.dsh-in-zotero.warmStart", true);
// Floating-panel geometry {left, top, width, height} (JSON, px).
pref("extensions.zotero.dsh-in-zotero.panelBox", "");
// Show the "译" translate button in the reader selection popup.
pref("extensions.zotero.dsh-in-zotero.translateEnabled", true);
// Auto-translate as soon as text is selected. Cold start is handled: the
// translate popup boots the sidecar via ensureStarted() when it isn't ready.
pref("extensions.zotero.dsh-in-zotero.translateAuto", false);
// Translate using reasoning mode when the selected model supports it.
pref("extensions.zotero.dsh-in-zotero.translateThinking", false);
// Translation model override, as 'provider/model' from dsh's registry.
// Empty = follow dsh's current model selection.
pref("extensions.zotero.dsh-in-zotero.translateModel", "");
// Manual desktop-install dir (with DeepSeek Harness.exe) — the fallback for
// installs the automatic detection cannot see (portable copies, custom
// locations). Empty = automatic detection only.
pref("extensions.zotero.dsh-in-zotero.desktopDir", "");
// Weekly GitHub-release update check with automatic download + install
// (CDN mirrors as download fallback). Timestamp of the last check is kept
// in lastUpdateCheck (ms epoch, internal).
pref("extensions.zotero.dsh-in-zotero.autoUpdate", true);
pref("extensions.zotero.dsh-in-zotero.lastUpdateCheck", 0);
// Startup dialog when Zotero's HTTP server (the「允许本机其他应用与 Zotero
// 通信」toggle every zotero_* tool depends on) is not listening. The dialog
// offers one-click enable; ticking 「不再提示」 sets this to true.
pref("extensions.zotero.dsh-in-zotero.suppressHttpServerPrompt", false);
