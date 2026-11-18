// dsh-in-zotero — plugin entry. Wires the wake buttons (items toolbar + reader
// toolbar), the context-menu action, the bridge endpoints, and the reader
// translate popup, then keeps everything alive until shutdown.

DSH.UI = (() => {
	const { log } = DSH.Util;

	const TOOLBAR_BUTTON_ID = 'zotero-tb-dsh-open';
	const READER_BUTTON_TITLE = 'DSH 会话（本文献）';
	const PREFS_PANE_ID = 'dsh-in-zotero';

	/** Register the settings pane; Zotero.PreferencePanes may not exist yet
	 * during early plugin startup, so callers retry until it sticks. */
	function registerPrefsPaneOnce() {
		try {
			if (typeof Zotero.PreferencePanes?.register !== 'function') return false;
			Zotero.PreferencePanes.register({
				id: PREFS_PANE_ID,
				pluginID: ctx.ID,
				src: ctx.rootURI + 'content/prefsPane.xhtml',
				scripts: [ctx.rootURI + 'content/prefsPane.js'],
				label: 'dsh-in-zotero',
				defaultXUL: true, // fragment uses bare XUL (html: prefix for HTML)
			});
			log('preference pane registered');
			return true;
		}
		catch (e) {
			log('preference pane register failed', e?.message ?? String(e), (e?.stack ?? '').slice(0, 400));
			return true; // it exists but refused us — retrying won't help
		}
	}

	async function ensurePrefsPane() {
		for (let tries = 0; tries < 20; tries++) {
			if (registerPrefsPaneOnce()) return;
			await Zotero.Promise.delay(3000);
		}
		log('preference pane never became available');
	}

	// --- items toolbar wake button ---------------------------------------------

	function ensureToolbarButton(win) {
		const doc = win.document;
		if (doc.getElementById(TOOLBAR_BUTTON_ID)) return;
		const toolbar = doc.getElementById('zotero-items-toolbar');
		if (!toolbar) {
			log('items toolbar not found yet');
			return;
		}
		const button = doc.createXULElement('toolbarbutton');
		button.id = TOOLBAR_BUTTON_ID;
		button.className = 'zotero-tb-button';
		button.setAttribute('tooltiptext', '打开 DSH 悬浮对话窗（加载一次后常驻，秒开）');
		button.setAttribute('style', 'list-style-image: url(chrome://dsh-in-zotero/content/icons/icon.svg)');
		button.addEventListener('command', () => {
			void openSessionWindow('list');
		});
		// "在『新建条目』『通过标识符添加条目』那条按钮组的最后"：append after the
		// note-add button, before the flexible spacer / search box.
		const noteAdd = doc.getElementById('zotero-tb-note-add');
		if (noteAdd && noteAdd.nextSibling) {
			toolbar.insertBefore(button, noteAdd.nextSibling);
		}
		else if (noteAdd) {
			toolbar.appendChild(button);
		}
		else {
			toolbar.appendChild(button);
		}
		log('toolbar button added');
	}

	// --- reader wake button (left of 外观 / Appearance) ----------------------------

	const READER_BUTTON_STYLE = `
.dsh-reader-button {
	position: relative;
	display: inline-flex; align-items: center; justify-content: center;
	width: 28px; height: 28px; margin-inline-end: 2px;
	border: none; border-radius: 5px; background: transparent;
	cursor: pointer; padding: 0;
}
.dsh-reader-button:hover { background: var(--fill-quinary); }
.dsh-reader-button svg { width: 18px; height: 18px; display: block; }
`;

	function ensureReaderButtonStyle(doc) {
		if (doc.getElementById('dsh-reader-button-style')) return;
		const style = doc.createElement('style');
		style.id = 'dsh-reader-button-style';
		style.textContent = READER_BUTTON_STYLE;
		doc.documentElement.appendChild(style);
	}

	function onRenderToolbar(event) {
		const { doc, append } = event;
		try {
			ensureReaderButtonStyle(doc);
			const button = doc.createElement('button');
			button.className = 'toolbar-button dsh-reader-button';
			button.title = READER_BUTTON_TITLE;
			button.innerHTML = `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
				<rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3.25" fill="#4D6BFE" stroke="#3a54cc" stroke-width="0.6"/>
				<path d="M8 3.1c-2.7 0-4.9 1.95-4.9 4.35 0 1.3.65 2.47 1.68 3.25l-.43 1.9 2.02-1.02c.51.14 1.06.22 1.63.22 2.7 0 4.9-1.95 4.9-4.35S10.7 3.1 8 3.1z" fill="#fff"/>
				<path d="M6.55 5.5v4.1h.92c1.05 0 1.7-.72 1.7-2.05 0-1.34-.65-2.05-1.7-2.05zm.75.72h.11c.6 0 .93.37.93 1.33s-.33 1.33-.93 1.33h-.11z" fill="#4D6BFE"/>
			</svg>`;
			button.addEventListener('click', () => {
				const reader = event.reader;
				const itemID = reader?.itemID ?? reader?._item?.id ?? null;
				void openSessionWindow('reader', itemID);
			});
			append(button);
		}
		catch (e) {
			log('reader toolbar render failed', e);
		}
	}

	// --- session window opening -------------------------------------------------

	async function openSessionWindow(mode, itemID = null) {
		// When dsh is already warm the open is instant — stay silent instead of
		// flashing a "starting" toast over the panel.
		const warm = DSH.Sidecar.isReady();
		const progress = warm ? null : DSH.Util.toast('DSH', '正在启动 dsh…');
		try {
			await DSH.Sidecar.ensureStarted({
				onStatus: (s) => progress?.update(s),
			});
			await DSH.SessionWindow.open(mode, itemID, { onStatus: (s) => progress?.update(s) });
			progress?.done('DSH 就绪');
		}
		catch (e) {
			log(`openSessionWindow failed: ${e?.message ?? e}\n${e?.stack ?? ''}`);
			progress?.error(`启动失败：${e.message}`);
			if (!progress) DSH.Util.toast('DSH', `打开失败：${e.message}`);
		}
	}

	// --- settings ----------------------------------------------------------------

	function openSettings() {
		try {
			Zotero.Utilities.Internal.openPreferences(PREFS_PANE_ID);
		}
		catch (e) {
			log('openPreferences failed', e?.message ?? e);
			try {
				Zotero.Utilities.Internal.openPreferences();
			}
			catch (e2) {
				DSH.Util.toast('DSH', '请在 Zotero 设置中查找 dsh-in-zotero');
			}
		}
	}

	return { ensureToolbarButton, onRenderToolbar, openSessionWindow, openSettings, ensurePrefsPane };
})();

// ---------------------------------------------------------------------------- hooks

Zotero.DSHinZotero = {
	/** Stop the sidecar now; the next open restarts it under current prefs
	 * (used by the cleanup flows, where a restart would immediately re-spawn
	 * the runtime that was just uninstalled). */
	async restartSidecar() {
		try {
			DSH.Sidecar.stop();
			DSH.Util.toast('DSH', '已停止 dsh 服务；下次打开时按新设置启动');
		}
		catch (e) {
			DSH.Util.log('restartSidecar failed', e);
		}
	},
	/** Stop AND restart right away under current prefs (the settings pane's
	 * 「保存设置并重启服务」 button). onStatus receives start-sequence lines
	 * so the pane can show progress. Throws when the restart fails. */
	async restartNow({ onStatus } = {}) {
		DSH.Sidecar.stop();
		await DSH.Sidecar.ensureStarted({ onStatus });
		DSH.Util.toast('DSH', '已按新设置重启 dsh 服务');
	},
	/** Detection snapshot for the settings pane (desktop install, bundled
	 * runtime readiness, effective mode). */
	dshSourceInfo() {
		return DSH.Sidecar.sourceInfo();
	},
	dshPluginDir() {
		return DSH.Sidecar.pluginDir();
	},
	/** Cleanup snapshot for the settings pane (what this plugin installed). */
	dshCleanupInfo() {
		return DSH.Sidecar.cleanupInfo();
	},
	/** One-click uninstall of the npm runtime the plugin installed. */
	uninstallBundledRuntime() {
		return DSH.Sidecar.removeBundledRuntime();
	},
	/** Remove the configured local dsh package dir (and its reference). */
	uninstallCustomDir() {
		return DSH.Sidecar.removeCustomDir();
	},
	/** Registered dsh models (settings pane's translate-model picker). */
	listModels() {
		return DSH.Sidecar.listModels();
	},
	/** Check GitHub for a newer release; opts.install downloads & installs it.
	 * opts.forceVersion fakes the installed version (debug/testing). */
	checkUpdate(opts = {}) {
		return DSH.Update.check(opts);
	},
	hooks: {
		onStartup() {
			DSH.Util.log('starting', ctx.VERSION);

			// Bridge endpoints must exist before the sidecar starts (its tools
			// call back into them).
			try {
				DSH.Bridge.register();
			}
			catch (e) {
				DSH.Util.log('bridge register failed', e);
			}

			// Weekly update check (GitHub releases; CDN download fallback).
			try {
				DSH.Update.register();
			}
			catch (e) {
				DSH.Util.log('update register failed', e);
			}

			// Settings pane (dsh source: bundled runtime / local install /
			// attach to a running instance; node path; translate options).
			void DSH.UI.ensurePrefsPane();

			// Reader hooks: wake button (renders left of 外观) + 译 popup.
			try {
				Zotero.Reader.registerEventListener('renderToolbar', DSH.UI.onRenderToolbar, ctx.ID);
			}
			catch (e) {
				DSH.Util.log('renderToolbar listener failed', e);
			}
			try {
				DSH.Translate.register();
			}
			catch (e) {
				DSH.Util.log('translate register failed', e);
			}

			// Windows already open at plugin startup never receive Zotero's
			// onMainWindowLoad (it only fires for windows opened later), so wire
			// them here — idempotent via the button-id guard inside.
			for (const win of Zotero.getMainWindows()) {
				try {
					Zotero.DSHinZotero.hooks.onMainWindowLoad(win);
				}
				catch (e) {
					DSH.Util.log('existing window wiring failed', e);
				}
			}

			// Stop the sidecar when Zotero exits.
			Zotero.addShutdownListener(() => {
				try { DSH.Sidecar.stop(); } catch (e) { /* best effort */ }
			});

			// Persist the bridge token next to the plugin data (same local trust
			// boundary as the Zotero prefs it already lives in) so local test
			// harnesses and diagnostics can find it deterministically.
			void (async () => {
				try {
					await DSH.Util.writeTextFile(
						DSH.Util.joinPath(DSH.Sidecar.dataDir(), 'bridge-token'),
						DSH.Sidecar.bridgeToken()
					);
				}
				catch (e) {
					DSH.Util.log('token file write failed', e);
				}
			})();
		},

		onMainWindowLoad(win) {
			try {
				DSH.UI.ensureToolbarButton(win);
			}
			catch (e) {
				DSH.Util.log('toolbar button failed', e);
			}
			try {
				DSH.Refetch.ensureMenuItem(win);
			}
			catch (e) {
				DSH.Util.log('context menu failed', e);
			}
			// The items toolbar is built dynamically in some layouts; retry briefly.
			let tries = 0;
			const timer = win.setInterval(() => {
				tries += 1;
				if (win.document.getElementById('zotero-tb-dsh-open') || tries > 20) {
					win.clearInterval(timer);
					return;
				}
				try { DSH.UI.ensureToolbarButton(win); } catch (e) { /* retry */ }
			}, 500);

			// Load the stylesheet for the session window strip.
			try {
				const link = win.document.createElement('link');
				link.rel = 'stylesheet';
				link.href = 'chrome://dsh-in-zotero/content/dsh.css';
				win.document.documentElement.appendChild(link);
			}
			catch (e) {
				DSH.Util.log('stylesheet failed', e);
			}
		},

		onMainWindowUnload(win) {
			try {
				const button = win.document.getElementById('zotero-tb-dsh-open');
				button?.remove();
				win.document.getElementById('dsh-in-zotero-refetch-menu')?.remove();
				win.document.getElementById('dsh-in-zotero-refetch-menu-separator')?.remove();
			}
			catch (e) { /* window is closing anyway */ }
		},

		onShutdown() {
			try { DSH.Sidecar.stop(); } catch (e) { /* best effort */ }
			try { DSH.Bridge.unregister(); } catch (e) { /* best effort */ }
			try { Zotero.Reader.unregisterEventListener?.('renderToolbar', DSH.UI.onRenderToolbar); } catch (e) { /* best effort */ }
			try { Zotero.Notifier.unregisterObserver('dsh-in-zotero-tabs'); } catch (e) { /* best effort */ }
			// Tear down the session surface (tab first: its onClose swaps the
			// page back, then the whole panel tree goes away with the browser).
			try {
				const s = DSH.SessionWindow.state;
				if (s.tab && s.window) s.window.Zotero_Tabs.close(s.tab.id);
				if (s.observeTimer) clearInterval(s.observeTimer);
				s.panel?.root?.remove();
			}
			catch (e) { /* window may already be gone */ }
			delete Zotero.DSHinZotero;
		},
	},
};
