// dsh-in-zotero settings-pane behaviour (loaded via PreferencePanes'
// `scripts` option — inline scripts in the pane fragment never execute).
// Input/pref syncing is handled by Zotero's automatic `preference` binding;
// this file swaps the per-mode hint, toggles the mode-conditional fields,
// fills the detected source info (desktop install / bridge plugin location),
// and wires the restart, update (manual check + release notes), install and
// cleanup buttons.

(function () {
	'use strict';

	const MODE_HINTS = {
		auto: '自动选择本机 dsh：优先下方填写的本地包目录（如有且有效），其次 dsh 桌面版自带的内核，最后 npm 内置运行时（首次自动安装）。与桌面版可同时运行（各自独立端口与会话 profile，共用 ~/.dsh 的凭据、模型与会话存档）。',
		bundled: '忽略桌面版，始终使用插件自己管理、npm 安装到插件数据目录的 @deepseek-ai/dsh（首次安装约需几分钟）。装了桌面版后可在下方「卸载本插件安装的 dsh」清掉它。',
		attach: '不启动任何进程，接入一个正在运行的 dsh web 实例（下方粘贴其带 token 的地址）。仅对话开箱可用；目标 profile 装上桥插件后翻译与文献工具也可用。',
	};
	const RESOLVED_NAMES = {
		desktop: '桌面版内核',
		custom: '本地包目录',
		bundled: '内置运行时',
		attach: '连接实例',
	};

	// Legacy 'desktop'/'custom' selections collapse into 'auto' — mirror
	// sidecar.js's normalization so an old stored pref never leaves the
	// menulist blank (the auto chain resolves them identically).
	function normalizeMode(value) {
		const mode = String(value ?? '').toLowerCase();
		if (mode === 'desktop' || mode === 'custom') return 'auto';
		return MODE_HINTS[mode] ? mode : 'auto';
	}

	function fmtBytes(bytes) {
		const mb = (Number(bytes) || 0) / (1024 * 1024);
		return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
	}

	/** Minimal markdown → HTML for GitHub release notes (headings, lists,
	 * bold/italic/inline-code, fenced code, links, images stripped to their
	 * alt text). Everything is HTML-escaped BEFORE the tag substitutions, so
	 * the note body can never inject markup — the only tags in the output are
	 * the ones produced here. */
	function mdToHtml(md) {
		const esc = (s) => String(s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		const inline = (s) => esc(s)
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image → alt text
			.replace(/`([^`]+)`/g, '<code>$1</code>')
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
			.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
		const out = [];
		let list = null;
		let code = null;
		const flushList = () => {
			if (list !== null) { out.push(`<ul>${list}</ul>`); list = null; }
		};
		for (const raw of String(md ?? '').split(/\r?\n/)) {
			if (/^\s*```/.test(raw)) {
				if (code !== null) { out.push(`<pre>${esc(code.join('\n'))}</pre>`); code = null; }
				else { flushList(); code = []; }
				continue;
			}
			if (code !== null) { code.push(raw); continue; }
			const line = raw.trimEnd();
			const heading = /^(#{1,4})\s+(.*)$/.exec(line);
			if (heading) {
				flushList();
				const level = Math.min(heading[1].length + 2, 6); // # → h3 … #### → h6
				out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
				continue;
			}
			const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
			if (bullet) {
				const item = `<li>${inline(bullet[1])}</li>`;
				list = list === null ? item : list + item;
				continue;
			}
			flushList();
			if (line.trim()) out.push(`<p>${inline(line)}</p>`);
		}
		flushList();
		if (code !== null) out.push(`<pre>${esc(code.join('\n'))}</pre>`);
		return out.join('');
	}

	function fillSourceInfo(doc) {
		// Runs in the prefs window; the main plugin API hangs off window.Zotero.
		const api = window.Zotero?.DSHinZotero;
		if (typeof api?.dshSourceInfo !== 'function') return;
		void Promise.resolve(api.dshSourceInfo()).then((info) => {
			const detected = doc.getElementById('dsh-source-detected');
			const pluginPath = doc.getElementById('dsh-attach-plugin-path');
			const bits = [];
			if (info?.desktop) {
				bits.push(info.desktop.engineOk === false
					? `已检测到 dsh 桌面版（${info.desktop.exe}），但其内未找到 dsh 内核——该版本布局不受支持，将自动改用其他来源`
					: `已检测到 dsh 桌面版：${info.desktop.exe}`);
			}
			if (info?.bundledReady) bits.push('内置运行时已安装');
			const resolved = info?.resolvedMode ?? '';
			if (resolved && normalizeMode(info?.mode) === 'auto') {
				bits.push(`当前生效来源：${RESOLVED_NAMES[resolved] ?? resolved}`);
			}
			if (detected) detected.textContent = bits.length ? bits.join('；') : '未检测到 dsh 桌面版；内置运行时未安装。首次打开会话时将弹窗选择来源。';
			if (pluginPath && api.dshPluginDir) {
				try { pluginPath.textContent = `桥插件文件位置：${api.dshPluginDir()}`; }
				catch (e) { /* leave placeholder */ }
			}
		}).catch(() => { /* detection failed — keep placeholder text */ });
	}

	/** The two "浏览…" buttons: open a folder picker RIGHT HERE in the prefs
	 * window's own sandbox. It must not be routed through the plugin's main
	 * sandbox (api.pickFolder): a XUL window object crossing sandboxes is not a
	 * valid nsIDOMWindow, and fp.init() throws "Could not convert JavaScript
	 * argument arg 0", silently doing nothing. Here `window` is the native
	 * prefs window, so the picker opens normally. The chosen path is written
	 * into the pref-bound textbox (an input event makes Zotero save it). */
	function wireDirPickers(doc) {
		// Gecko 128+/Zotero 8 changed nsIFilePicker.init's first argument from
		// an nsIDOMWindow to a BrowsingContext — passing a window throws
		// "Could not convert JavaScript argument arg 0" (verified against
		// Zotero's own certManager.js: fp.init(window.browsingContext, …)).
		// The prefs pane's own browsingContext is the correct parent here.
		const parent = window.browsingContext ?? null;
		window.__dshPickerReady = parent ? 'browsingContext' : 'no browsingContext';

		const pick = (title) => new Promise((resolve) => {
			if (!parent) { resolve(null); return; }
			try {
				const fp = Components.classes['@mozilla.org/filepicker;1']
					.createInstance(Components.interfaces.nsIFilePicker);
				fp.init(parent, title, Components.interfaces.nsIFilePicker.modeGetFolder);
				fp.open((result) => {
					resolve(result === Components.interfaces.nsIFilePicker.returnOK
						? fp.file?.path ?? null
						: null);
				});
			}
			catch (e) {
				Zotero?.logError?.(e);
				resolve(null);
			}
		});
		const bind = (btnId, inputId, title) => {
			doc.getElementById(btnId)?.addEventListener('command', () => {
				void pick(title).then((dir) => {
					if (!dir) return; // cancelled
					const input = doc.getElementById(inputId);
					if (!input) return;
					input.value = dir;
					input.dispatchEvent(new Event('input', { bubbles: true }));
				});
			});
		};
		bind('dsh-custom-pick', 'dsh-custom-dir', '选择包含 lib/bin.js 的 dsh 包目录');
		bind('dsh-desktop-pick', 'dsh-desktop-dir', '选择 dsh 桌面版安装目录（含 DeepSeek Harness.exe）');
	}

	/** The install section: reflect whether the npm runtime is present and
	 * wire the install button (counterpart of the uninstall section below). */
	function fillInstall(doc) {
		const api = window.Zotero?.DSHinZotero;
		if (typeof api?.dshCleanupInfo !== 'function') return;
		const statusEl = doc.getElementById('dsh-install-status');
		const btn = doc.getElementById('dsh-install-bundled');
		const refresh = async () => {
			try {
				const info = await Promise.resolve(api.dshCleanupInfo());
				const has = !!info?.runtime;
				if (btn) btn.disabled = has;
				if (statusEl) statusEl.textContent = has
					? `内置运行时已安装：${info.runtime.path}。无需重复安装；如需更换版本，先在下方卸载。`
					: '未安装 npm 内置运行时。点下方按钮一键安装 @deepseek-ai/dsh（需 Node ≥ 24.9，约 1-3 分钟）。';
			}
			catch (e) {
				if (statusEl) statusEl.textContent = `状态检测失败：${e?.message ?? e}`;
			}
		};
		doc.getElementById('dsh-install-refresh')?.addEventListener('command', () => { void refresh(); });
		btn?.addEventListener('command', async () => {
			if (typeof api?.installBundledRuntime !== 'function' || btn.disabled) return;
			const prev = btn.label;
			btn.disabled = true;
			btn.label = '正在安装…';
			const show = (text) => { if (statusEl) statusEl.textContent = text; };
			try {
				await api.installBundledRuntime(show);
				show('内置运行时安装完成。可在「来源」中选「npm 内置运行时」或保持「自动检测」。');
				fillCleanup(doc); // refresh the uninstall section too
			}
			catch (e) {
				show(`安装失败：${e?.message ?? e}`);
			}
			finally {
				btn.label = prev;
				await refresh();
			}
		});
		void refresh();
	}

	/** The uninstall section: show what the plugin installed, wire the two
	 * removal buttons (the custom-dir one gated by an explicit checkbox —
	 * it is the USER's directory, not plugin-owned). */
	function fillCleanup(doc) {
		const api = window.Zotero?.DSHinZotero;
		if (typeof api?.dshCleanupInfo !== 'function') return;
		const statusEl = doc.getElementById('dsh-cleanup-status');
		const bundledBox = doc.getElementById('dsh-cleanup-bundled-box');
		const customBox = doc.getElementById('dsh-cleanup-custom-box');
		void Promise.resolve(api.dshCleanupInfo()).then((info) => {
			const hasRuntime = !!info?.runtime;
			const hasCustom = !!info?.custom?.path;
			if (bundledBox) bundledBox.hidden = !hasRuntime;
			if (customBox) customBox.hidden = !hasCustom;
			if (hasRuntime) {
				const el = doc.getElementById('dsh-cleanup-bundled-path');
				if (el) {
					el.textContent = info.runtime.symlink
						? `npm 内置运行时位置：${info.runtime.path} —— 这是一个符号链接${info.runtime.symlinkBroken ? '（已失效，目标不存在）' : `（指向 ${info.runtime.symlinkTarget || '外部目录'}）`}，移除只删链接本身、不动目标目录`
						: `npm 内置运行时：${info.runtime.path}（约 ${fmtBytes(info.runtime.bytes)}）`;
				}
			}
			if (hasCustom) {
				const el = doc.getElementById('dsh-cleanup-custom-path');
				if (el) el.textContent = `本地 dsh 包目录：${info.custom.path}${info.custom.exists ? '' : '（目录已不存在，仅剩引用）'}`;
				const hintEl = doc.getElementById('dsh-cleanup-custom-hint');
				if (hintEl && info.custom.looksNpm) {
					hintEl.textContent = '该路径位于 node_modules 下（npm 安装），删除后也可用 npm uninstall -g @deepseek-ai/dsh 清理全局残留。';
				}
			}
			if (statusEl) {
				if (!hasRuntime && !hasCustom) {
					statusEl.textContent = '没有可卸载的组件（未安装 npm 内置运行时，也未设置本地包目录）。';
				}
				else if (info.desktop) {
					statusEl.textContent = '已检测到 dsh 桌面版：以下组件已不再被使用（自动检测优先桌面版内核），可安全卸载。';
				}
				else {
					statusEl.textContent = '卸载后插件将改用「自动检测」的来源重新解析。';
				}
			}
		}).catch(() => {
			if (statusEl) statusEl.textContent = '组件检测失败，请重开设置页面。';
		});

		doc.getElementById('dsh-cleanup-bundled')?.addEventListener('command', () => {
			const path = doc.getElementById('dsh-cleanup-bundled-path')?.textContent ?? '';
			const ok = Services.prompt.confirm(window, '卸载 npm 内置运行时',
				`将删除插件安装的 dsh 运行时（体积见下方路径行，重新安装需 npm 重新下载）。\n\n${path}\n\n会话存档与模型配置（~/.dsh）不受影响。继续？`);
			if (!ok) return;
			void Promise.resolve(api.uninstallBundledRuntime()).then((result) => {
				window.Zotero?.DSHinZotero?.restartSidecar?.(); // release any file locks now
				DSHinZoteroPaneToast(doc, result.ok ? '已卸载 npm 内置运行时；下次启动按「自动检测」选择来源' : '删除未完成（文件被占用），已停止服务，请稍后在设置里重试');
				fillCleanup(doc);
			}).catch((e) => DSHinZoteroPaneToast(doc, `卸载失败：${e?.message ?? e}`));
		});

		const confirmBox = doc.getElementById('dsh-cleanup-custom-confirm');
		const customButton = doc.getElementById('dsh-cleanup-custom');
		confirmBox?.addEventListener('command', () => {
			if (customButton) customButton.disabled = !confirmBox.checked;
		});
		customButton?.addEventListener('command', () => {
			const path = doc.getElementById('dsh-cleanup-custom-path')?.textContent ?? '';
			const ok = Services.prompt.confirm(window, '删除本地 dsh 包目录',
				`将永久删除该目录及其全部内容（不可恢复）：\n\n${path}\n\n继续？`);
			if (!ok) return;
			void Promise.resolve(api.uninstallCustomDir()).then((result) => {
				if (confirmBox) confirmBox.checked = false;
				if (customButton) customButton.disabled = true;
				window.Zotero?.DSHinZotero?.restartSidecar?.();
				DSHinZoteroPaneToast(doc, result.ok ? '已删除本地包目录并清除引用；下次启动按「自动检测」选择来源' : '删除未完成（文件被占用），已停止服务，请稍后在设置里重试');
				fillCleanup(doc);
			}).catch((e) => DSHinZoteroPaneToast(doc, `删除失败：${e?.message ?? e}`));
		});
	}

	/** The wish button: open a fresh DSH session pre-briefed for feature
	 * wishes / bug fixes on this very plugin (repo URL + PR flow live in the
	 * briefing injected by the bridge's task.wish op). All the work — cold
	 * start, session creation, panel surfacing — happens in the main sandbox;
	 * errors are toasted there, so this side just fires and forgets. */
	function wireWish(doc) {
		doc.getElementById('dsh-wish-button')?.addEventListener('command', () => {
			const api = window.Zotero?.DSHinZotero;
			if (typeof api?.openWishSession !== 'function') return;
			try {
				void Promise.resolve(api.openWishSession()).catch(() => { /* toasted by the API */ });
			}
			catch (e) {
				Zotero?.logError?.(e);
			}
		});
	}

	/** The update section: current vs remote version, a manual check button
	 *  (independent of the weekly auto-check), a download+install button that
	 *  only unlocks when the check found something newer, and the remote
	 *  release notes rendered from markdown. One silent check fires when the
	 *  pane opens so the versions line is informative without a click. */
	function wireUpdate(doc) {
		const versions = doc.getElementById('dsh-update-versions');
		const checkBtn = doc.getElementById('dsh-update-check');
		const installBtn = doc.getElementById('dsh-update-install');
		const statusEl = doc.getElementById('dsh-update-status');
		if (!versions || !checkBtn) return;
		const api = () => window.Zotero?.DSHinZotero;
		const show = (text) => {
			if (statusEl) { statusEl.hidden = !text; statusEl.textContent = text ?? ''; }
		};

		let current = '';
		try { current = String(api()?.version?.() ?? ''); }
		catch (e) { /* cosmetic — label falls back to ？ */ }
		const paintVersions = (latest, available) => {
			versions.textContent = `当前版本 ${current || '？'}　·　远端最新 ${latest || '？'}`
				+ (available ? '（有新版本）' : latest ? '（已是最新）' : '');
		};
		paintVersions('', false);

		const fmtDate = (iso) => {
			try {
				const d = new Date(iso);
				if (Number.isNaN(d.getTime())) return '';
				const two = (n) => String(n).padStart(2, '0');
				return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
			}
			catch (e) { return ''; }
		};

		const renderNotes = (info) => {
			const box = doc.getElementById('dsh-release-box');
			const title = doc.getElementById('dsh-release-title');
			const notes = doc.getElementById('dsh-release-notes');
			if (!box) return;
			const body = mdToHtml(info?.notes);
			if (!body) { box.hidden = true; return; }
			const date = fmtDate(info?.publishedAt);
			if (title) title.textContent = `远端发行说明：v${info?.latest ?? ''}${info?.releaseName ? ` ${info.releaseName}` : ''}${date ? `（${date} 发布）` : ''}`;
			if (notes) notes.innerHTML = body;
			box.hidden = false;
		};

		// Links inside the notes open externally — the pane never navigates.
		const openLink = (url) => {
			try { window.Zotero?.launchURL?.(url); }
			catch (e) { try { window.open(url, '_blank'); } catch (e2) { /* give up */ } }
		};
		doc.getElementById('dsh-release-notes')?.addEventListener('click', (ev) => {
			const anchor = ev.target.closest?.('a[href]');
			if (!anchor) return;
			ev.preventDefault();
			openLink(anchor.getAttribute('href'));
		});

		const runCheck = async () => {
			const a = api();
			if (typeof a?.checkUpdate !== 'function' || checkBtn.disabled) return;
			checkBtn.disabled = true;
			const prevLabel = checkBtn.label;
			checkBtn.label = '正在检查…';
			try {
				const info = await a.checkUpdate();
				current = String(info?.current ?? current);
				paintVersions(info?.latest ?? '', !!info?.updateAvailable);
				if (installBtn) installBtn.disabled = !info?.updateAvailable;
				renderNotes(info);
				show(info?.updateAvailable
					? `发现新版本 ${info.latest}，点「下载并安装」更新（安装后需重启 Zotero 生效）。`
					: '已是最新版本。');
			}
			catch (e) {
				show(`检查更新失败：${e?.message ?? e}`);
			}
			finally {
				checkBtn.label = prevLabel;
				checkBtn.disabled = false;
			}
		};
		checkBtn.addEventListener('command', () => { void runCheck(); });

		installBtn?.addEventListener('command', async () => {
			const a = api();
			if (typeof a?.checkUpdate !== 'function' || installBtn.disabled) return;
			installBtn.disabled = true;
			const prevLabel = installBtn.label;
			installBtn.label = '正在下载并安装…';
			try {
				const info = await a.checkUpdate({ install: true });
				if (info?.installed) show(`已下载并安装 ${info.latest}，重启 Zotero 后生效。`);
				else if (!info?.updateAvailable) show('检查时已是最新版本。');
			}
			catch (e) {
				show(`下载或安装失败：${e?.message ?? e}`);
				installBtn.disabled = false; // let the user retry without re-checking
				installBtn.label = prevLabel;
				return;
			}
			installBtn.label = prevLabel;
		});

		// Fill the remote half of the versions line once, silently.
		void runCheck();
	}

	/** The prefs window has no Zotero.ProgressWindow; surface result lines in
	 * the cleanup status label instead. */
	function DSHinZoteroPaneToast(doc, text) {
		const el = doc.getElementById('dsh-cleanup-status');
		if (el) el.textContent = text;
	}

	/** The translate-model picker: '' (inherit) follows dsh's current model;
	 * the other options are dsh's registered models, loaded via the sidecar
	 * (refresh button, plus one automatic attempt when the pane opens). The
	 * menu is dynamic, so the pref is read/written manually instead of via
	 * Zotero's automatic preference binding. */
	function wireTranslateModel(doc) {
		const menu = doc.getElementById('dsh-translate-model');
		if (!menu || doc.getElementById('dsh-translate-model-wired')) return;
		const marker = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
		marker.id = 'dsh-translate-model-wired';
		marker.style.display = 'none';
		(menu.parentNode || doc.documentElement).appendChild(marker);

		const INHERIT = '';
		const PREF = 'extensions.zotero.dsh-in-zotero.translateModel';
		const readPref = () => {
			try { return String(Zotero.Prefs.get(PREF, true) ?? ''); }
			catch (e) { return INHERIT; }
		};
		const writePref = (v) => {
			try { Zotero.Prefs.set(PREF, String(v ?? ''), true); }
			catch (e) { /* keep UI choice only */ }
		};
		const selectValue = (v) => {
			for (const item of menu.querySelectorAll('menuitem')) {
				if (item.getAttribute('value') === v) {
					menu.selectedItem = item;
					return true;
				}
			}
			return false;
		};
		menu.addEventListener('command', () => {
			if (menu.selectedItem) writePref(menu.selectedItem.getAttribute('value'));
		});

		const fill = async () => {
			const api = window.Zotero?.DSHinZotero;
			if (typeof api?.listModels !== 'function') return;
			const statusEl = doc.getElementById('dsh-translate-model-hint');
			try {
				const info = await Promise.resolve(api.listModels());
				const models = Array.isArray(info?.models) ? info.models : [];
				if (!models.length) {
					if (statusEl) statusEl.textContent = '暂未取到模型列表：dsh 服务启动后再点「刷新列表」。当前保持「继承 dsh 当前使用的模型」。';
					return;
				}
				const popup = doc.getElementById('dsh-translate-model-popup');
				if (!popup) return;
				popup.replaceChildren();
				const inherit = doc.createXULElement('menuitem');
				inherit.setAttribute('value', INHERIT);
				inherit.setAttribute('label', '继承 dsh 当前使用的模型');
				popup.appendChild(inherit);
				const currentId = info?.current?.provider && info?.current?.model
					? `${info.current.provider}/${info.current.model}`
					: '';
				for (const model of models) {
					const item = doc.createXULElement('menuitem');
					item.setAttribute('value', String(model.id ?? ''));
					const name = String(model.name ?? model.id ?? '');
					item.setAttribute('label', currentId && String(model.id) === currentId ? `${name}（dsh 当前使用）` : name);
					popup.appendChild(item);
				}
				// Keep the stored choice selected if it survived the refresh;
				// otherwise fall back to inherit (the pref is untouched, so the
				// stored id still applies once its model is registered again).
				if (!selectValue(readPref())) selectValue(INHERIT);
				if (statusEl) statusEl.textContent = `已加载 ${models.length} 个模型；选择后立即生效。`;
			}
			catch (e) {
				if (statusEl) statusEl.textContent = `模型列表获取失败：${e?.message ?? e}`;
			}
		};

		doc.getElementById('dsh-translate-model-refresh')?.addEventListener('command', () => { void fill(); });
		if (!selectValue(readPref())) selectValue(INHERIT);
		// The sidecar is usually already warm when the pane opens.
		void fill();
	}

	function wire(doc) {
		const menu = doc.getElementById('dsh-mode-menu');
		if (!menu || doc.getElementById('dsh-pane-wired')) return;

		const marker = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
		marker.id = 'dsh-pane-wired';
		marker.style.display = 'none';
		(menu.parentNode || doc.documentElement).appendChild(marker);

		const hint = doc.getElementById('dsh-mode-hint');
		const custom = doc.getElementById('dsh-custom-box');
		const attach = doc.getElementById('dsh-attach-box');
		const nodeBox = doc.getElementById('dsh-node-box');
		const nodeHint = doc.getElementById('dsh-node-hint');
		const desktopBox = doc.getElementById('dsh-desktop-box');
		const sync = () => {
			const raw = String(menu.value ?? '');
			const mode = normalizeMode(raw);
			// A legacy stored value matches no menuitem — repoint the menulist
			// at the normalized one (visual only; the pref is only rewritten
			// when the user picks something).
			if (raw && raw.toLowerCase() !== mode) menu.value = mode;
			if (hint) hint.textContent = MODE_HINTS[mode];
			if (custom) custom.hidden = mode !== 'auto';
			if (attach) attach.hidden = mode !== 'attach';
			const needNode = mode !== 'attach';
			if (nodeBox) nodeBox.hidden = !needNode;
			if (nodeHint) nodeHint.hidden = !needNode;
			if (desktopBox) desktopBox.hidden = !needNode;
		};
		menu.addEventListener('command', sync);
		// The automatic preference binding populates after first paint.
		setTimeout(sync, 50);
		setTimeout(sync, 400);

		wireTranslateModel(doc);

		doc.getElementById('dsh-restart-button')?.addEventListener('command', async () => {
			const btn = doc.getElementById('dsh-restart-button');
			const statusEl = doc.getElementById('dsh-restart-status');
			const api = window.Zotero?.DSHinZotero;
			if (!btn || typeof api?.restartNow !== 'function' || btn.disabled) return;
			btn.disabled = true;
			const prevLabel = btn.label;
			btn.label = '正在重启 dsh 服务…';
			const show = (text) => {
				if (statusEl) {
					statusEl.hidden = !text;
					statusEl.textContent = text ?? '';
				}
			};
			try {
				await api.restartNow({ onStatus: show });
				show('已按新设置重启');
			}
			catch (e) {
				window.Zotero?.logError?.(e);
				show(`重启失败：${e?.message ?? e}`);
			}
			finally {
				btn.disabled = false;
				btn.label = prevLabel;
			}
		});

		fillSourceInfo(doc);
		wireDirPickers(doc);
		fillInstall(doc);
		fillCleanup(doc);
		wireWish(doc);
		wireUpdate(doc);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => wire(document), { once: true });
	}
	else {
		wire(document);
		// The pane may be injected as a fragment after this script first ran —
		// retry briefly until our elements exist.
		let tries = 0;
		const timer = setInterval(() => {
			tries += 1;
			const found = !!document.getElementById('dsh-mode-menu');
			if (found) wire(document);
			if (found || tries > 40) clearInterval(timer);
		}, 100);
	}
})();
