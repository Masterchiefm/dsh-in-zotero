// dsh-in-zotero — the DSH session surface. TWO hosts share ONE live dsh web
// page:
//
//  - a floating panel over the library (default). Its narrow width makes the
//    dsh UI auto-collapse its session sidebar (< 1024px), leaving the chat
//    front and centre; the sidebar re-opens as a drawer inside the page.
//  - a full Zotero tab ("切换为标签页" in the panel header, and back again).
//
// The embedded page is fully loaded at most ONCE per sidecar run: the first
// load uses a cookie-authenticated bare URL (no ?token → no redirect → no
// dropped fragment), and every later session switch is a hash-only navigation
// (same-document, no "Loading plugins" splash again). Switching hosts swaps
// the browser contents (browser.swapBrowsers), never reloading the page.
// Closing the panel merely hides it — the page and the sidecar stay warm, so
// re-opening is instant.
//
// Two entry modes mirror the two wake buttons:
//  - 'list'   (items toolbar): every open binds a brand-new dsh session;
//  - 'reader' (reader toolbar): each article keeps ONE bound session — reopen
//    returns to it; creating a new session here rebinds the article.
//
// While the surface is on screen it FOLLOWS the active Zotero tab (Notifier
// 'select' events): selecting a reader tab shows that article's bound session
// (silently creating + binding one when absent), selecting the library tab
// keeps the current conversation but re-targets the guidance context to list
// mode. Tab-following is silent — no rebinding toasts.

DSH.SessionWindow = (() => {
	const { log, prefGetJSON, prefSetJSON, toast } = DSH.Util;

	const TAB_TYPE = 'dsh-session';
	const PANEL_HOST_ID = 'dsh-panel-host';
	const PANEL_MIN = { width: 360, height: 320 };
	const PANEL_DEFAULT = { width: 460, height: 560 };

	const state = {
		window: null, // the main window owning everything
		host: null, // 'panel' | 'tab' | null (hidden — page kept alive)
		panel: null, // { root(host box), box(panel vbox), strip, browser, grip }
		tab: null, // { id, strip, browser }
		browser: null, // the browser element currently holding the live page
		strips: [], // every strip (panel + tab) — refreshed together
		current: null, // { mode, itemID, sessionId }
		observeTimer: null,
		navigating: false,
		collapsed: false,
		suppressFollow: false, // true while a host switch is rearranging tabs
		followSeq: 0, // bump on every tab-follow — stale follows self-abandon
		navSeq: 0, // bump on every navigateToSession — stale navigations abort
	};

	// --- bindings -------------------------------------------------------------

	function bindings() {
		return prefGetJSON('bindings', {});
	}

	function getBinding(itemID) {
		return bindings()[String(itemID)] ?? null;
	}

	function setBinding(itemID, sessionId) {
		const map = bindings();
		if (sessionId) map[String(itemID)] = sessionId;
		else delete map[String(itemID)];
		prefSetJSON('bindings', map);
	}

	function itemTitle(itemID) {
		try {
			const item = Zotero.Items.get(itemID);
			if (!item?.id) return '';
			if (item.isAttachment()) {
				const parent = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
				return parent?.getDisplayTitle?.() ?? item.getField('title') ?? '';
			}
			return item.getDisplayTitle?.() ?? '';
		}
		catch (e) {
			return '';
		}
	}

	/** Lightweight metadata snapshot of the article (itemType/creators/date/
	 * DOI/abstract excerpt) for the injected system-prompt context. */
	function itemMeta(itemID) {
		try {
			const item = Zotero.Items.get(itemID);
			if (!item?.id) return undefined;
			const target = item.isAttachment() && item.parentItemID
				? Zotero.Items.get(item.parentItemID)
				: item;
			if (!target?.id) return undefined;
			const meta = {};
			try { meta.itemType = Zotero.ItemTypes.getName(target.itemTypeID); } catch (e) { /* cosmetic */ }
			const doi = target.getField?.('DOI');
			if (doi) meta.DOI = String(doi);
			const date = String(target.getField?.('date') ?? '').trim();
			if (date) meta.date = date;
			const names = (target.getCreators?.() ?? [])
				.slice(0, 8)
				.map(c => c?.name || [c?.firstName, c?.lastName].filter(Boolean).join(' '))
				.filter(Boolean);
			if (names.length) meta.creators = names;
			const abstract = String(target.getField?.('abstractNote') ?? '').trim();
			if (abstract) meta.abstract = abstract.slice(0, 500);
			return Object.keys(meta).length ? meta : undefined;
		}
		catch (e) {
			return undefined;
		}
	}

	// --- session ops (via the bridge plugin inside the sidecar) ----------------

	/** Load a URL into the live browser. Always goes through the explicit
	 * navigation APIs — never the src attribute, whose change forces a full
	 * load (fragment-only switches must stay same-document). */
	function loadBrowser(url, { fragmentOnly = false } = {}) {
		const browser = state.browser;
		if (!browser) return;
		const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
		try {
			// Gecko 128+ element API
			browser.fixupAndLoadURIString(url, { triggeringPrincipal });
		}
		catch (e) {
			try {
				// Legacy 5-arg nsIWebNavigation form
				browser.webNavigation.loadURI(
					url,
					Components.interfaces.nsIWebNavigation.LOAD_FLAGS_NONE,
					null, null, null
				);
			}
			catch (e2) {
				log(`loadURI failed: ${e2?.message ?? e2}`);
			}
		}
	}

	function stripHash(spec) {
		return String(spec ?? '').replace(/#.*$/, '');
	}

	async function createSession(title) {
		const result = await DSH.Sidecar.plugin('session.create', { title });
		return result.sessionId;
	}

	async function resolveSession(sessionId) {
		if (!sessionId) return false;
		try {
			const result = await DSH.Sidecar.plugin('session.resolve', { sessionId });
			return result.alive === true;
		}
		catch (e) {
			return false;
		}
	}

	async function listSessions() {
		const result = await DSH.Sidecar.plugin('session.list', {});
		return result.items ?? [];
	}

	function degraded() {
		return DSH.Sidecar.state.bridgeOk === false;
	}

	/** Friendly dropdown label — never a raw session id (dsh leaves freshly
	 * created sessions untitled until its title service names them). */
	function sessionLabel(session) {
		const title = String(session?.title ?? '').trim();
		if (title) return title;
		try {
			const d = new Date(Number(session?.updatedAt) || Date.now());
			const two = (n) => String(n).padStart(2, '0');
			return `未命名会话 ${d.getMonth() + 1}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
		}
		catch (e) {
			return '未命名会话';
		}
	}

	// --- strip (shared by both hosts) -------------------------------------------

	/**
	 * @param {'panel'|'tab'} kind — the panel strip adds collapse/settings/close
	 * and doubles as the drag handle (buttons opt out via cursor + drag guard);
	 * the tab strip carries the back-switch as an icon pinned to the far right.
	 */
	function makeStrip(win, kind) {
		const doc = win.document;
		const root = doc.createXULElement('hbox');
		root.setAttribute('class', 'dsh-strip');
		root.setAttribute('align', 'center');

		const icon = doc.createElement('image');
		icon.setAttribute('class', 'dsh-strip-icon');
		icon.setAttribute('src', 'chrome://dsh-in-zotero/content/icons/icon.svg');

		const label = doc.createElement('label');
		label.setAttribute('class', 'dsh-strip-title');
		label.setAttribute('value', 'DSH');

		const selector = doc.createXULElement('menulist');
		selector.setAttribute('class', 'dsh-session-select');
		selector.setAttribute('flex', '1');
		const popup = doc.createXULElement('menupopup');
		selector.appendChild(popup);
		selector.addEventListener('command', () => {
			const sessionId = selector.value;
			if (sessionId && sessionId !== state.current?.sessionId) {
				void switchSession(sessionId);
			}
		});

		const newButton = doc.createXULElement('toolbarbutton');
		newButton.setAttribute('label', kind === 'panel' ? '新建' : '新建会话');
		newButton.setAttribute('class', 'dsh-strip-button dsh-new-session');
		newButton.setAttribute('tooltiptext', '新建会话');
		newButton.addEventListener('command', () => void newSessionForCurrentMode());

		const hostButton = doc.createXULElement('toolbarbutton');
		if (kind === 'panel') {
			// Icon-only (window-maximize glyph, styled in dsh.css).
			hostButton.setAttribute('tooltiptext', '切换为完整标签页（会话不中断）');
			hostButton.addEventListener('command', () => setHost('tab'));
		}
		else {
			// Icon-only too (window-restore glyph): the label wasted prime strip
			// space — the button now sits alone at the strip's right edge.
			hostButton.setAttribute('tooltiptext', '切换回悬浮窗（会话不中断）');
			hostButton.addEventListener('command', () => setHost('panel'));
		}
		hostButton.setAttribute('class', 'dsh-strip-button dsh-host-switch');

		const status = doc.createElement('label');
		status.setAttribute('class', 'dsh-strip-status');
		status.setAttribute('value', '');
		status.setAttribute('crop', 'end');
		status.setAttribute('flex', kind === 'panel' ? '0' : '1');

		const strip = { kind, root, selector, popup, status, newButton };
		if (kind === 'panel') {
			const settings = doc.createXULElement('toolbarbutton');
			settings.setAttribute('label', '设置');
			settings.setAttribute('class', 'dsh-strip-button dsh-settings');
			settings.setAttribute('tooltiptext', '打开 dsh-in-zotero 设置（dsh 来源、翻译等）');
			settings.addEventListener('command', () => DSH.UI.openSettings());

			const collapse = doc.createXULElement('toolbarbutton');
			collapse.setAttribute('class', 'dsh-strip-button dsh-collapse');
			collapse.setAttribute('tooltiptext', '收起 / 展开');
			collapse.addEventListener('command', () => toggleCollapse());

			const close = doc.createXULElement('toolbarbutton');
			close.setAttribute('class', 'dsh-strip-button dsh-close');
			close.setAttribute('tooltiptext', '关闭悬浮窗（dsh 继续在后台运行）');
			close.addEventListener('command', () => setHost(null));

			// Panel order: 新建 设置 折叠 标签页(icon) 关闭
			root.append(icon, label, selector, newButton, settings, collapse, hostButton, close);
			root.addEventListener('mousedown', (event) => startPanelDrag(event), { passive: true });
			root.appendChild(status);
		}
		else {
			// Tab order: selector stretches, status soaks up the slack, and the
			// restore icon lands last — visually pinned to the top-right corner.
			root.append(icon, label, selector, newButton, status);
			root.appendChild(hostButton);
		}

		state.strips.push(strip);
		return strip;
	}

	function makeBrowser(win) {
		// Zotero refuses to load http(s) into IN-PROCESS main-window browsers
		// (silent no-op), but a REMOTE browser (web content process) loads it
		// like a normal web tab. Control then goes through messageManager.
		const browser = win.document.createXULElement('browser');
		browser.setAttribute('flex', '1');
		browser.setAttribute('type', 'content');
		browser.setAttribute('class', 'dsh-session-browser');
		browser.setAttribute('remote', 'true');
		browser.setAttribute('maychangeremoteness', 'true');
		browser.setAttribute('disablehistory', 'true');
		return browser;
	}

	// --- floating panel -----------------------------------------------------------

	function panelBoxPref() {
		return prefGetJSON('panelBox', {});
	}

	function currentBox() {
		const root = state.panel?.root;
		const win = state.window;
		const saved = panelBoxPref();
		const width = Math.max(PANEL_MIN.width, Math.min(Number(saved.width) || PANEL_DEFAULT.width, win?.innerWidth ?? PANEL_DEFAULT.width));
		const height = Math.max(PANEL_MIN.height, Math.min(Number(saved.height) || PANEL_DEFAULT.height, win?.innerHeight ?? PANEL_DEFAULT.height));
		let left = Number(saved.left);
		let top = Number(saved.top);
		if (!Number.isFinite(left) || !Number.isFinite(top) || !root) {
			// Default: bottom-right corner of the library window.
			left = Math.max(8, (win?.innerWidth ?? width) - width - 16);
			top = Math.max(8, (win?.innerHeight ?? height) - height - 16);
		}
		return { left, top, width, height };
	}

	function clampBox(box) {
		const win = state.window;
		if (!win) return box;
		const maxX = Math.max(8, win.innerWidth - 80);
		const maxY = Math.max(8, win.innerHeight - 60);
		return {
			left: Math.min(Math.max(box.left, 80 - box.width), maxX),
			top: Math.min(Math.max(box.top, 0), maxY),
			width: Math.min(Math.max(box.width, PANEL_MIN.width), win.innerWidth),
			height: Math.min(Math.max(box.height, PANEL_MIN.height), win.innerHeight),
		};
	}

	function applyBox(box) {
		const root = state.panel?.root;
		if (!root) return;
		root.style.left = `${box.left}px`;
		root.style.top = `${box.top}px`;
		root.style.width = `${box.width}px`;
		root.style.height = `${box.height}px`;
	}

	function saveBox() {
		const root = state.panel?.root;
		if (!root) return;
		prefSetJSON('panelBox', {
			left: parseFloat(root.style.left) || 0,
			top: parseFloat(root.style.top) || 0,
			width: parseFloat(root.style.width) || PANEL_DEFAULT.width,
			height: parseFloat(root.style.height) || PANEL_DEFAULT.height,
		});
	}

	/** Dragging the panel by its strip (buttons/menulist excluded). */
	function startPanelDrag(event) {
		if (event.button !== 0) return;
		const target = event.target;
		if (target.closest && target.closest('button, toolbarbutton, menulist, menu, menuitem')) return;
		const win = state.window;
		const root = state.panel?.root;
		if (!win || !root) return;
		const rect = root.getBoundingClientRect();
		const grabX = event.clientX - rect.left;
		const grabY = event.clientY - rect.top;
		const move = (ev) => {
			applyBox(clampBox({
				left: ev.clientX - grabX,
				top: ev.clientY - grabY,
				width: rect.width,
				height: state.collapsed ? PANEL_MIN.height : rect.height,
			}));
		};
		const up = () => {
			win.removeEventListener('mousemove', move, true);
			win.removeEventListener('mouseup', up, true);
			saveBox();
		};
		win.addEventListener('mousemove', move, true);
		win.addEventListener('mouseup', up, true);
	}

	/** 8-direction resize: the styled grip is the SE corner; .dsh-panel-handle
	 * elements cover every other edge/corner (styles in dsh.css). The anchor is
	 * the opposite edge/corner of the gesture direction. */
	function startPanelResize(event, dir = 'se') {
		if (event.button !== 0) return;
		const win = state.window;
		const root = state.panel?.root;
		if (!win || !root) return;
		event.preventDefault();
		const rect = root.getBoundingClientRect();
		const startX = event.clientX;
		const startY = event.clientY;
		const collapsed = state.collapsed;
		const move = (ev) => {
			applyBox(resizeBox(rect, dir, ev.clientX - startX, ev.clientY - startY, collapsed));
		};
		const up = () => {
			win.removeEventListener('mousemove', move, true);
			win.removeEventListener('mouseup', up, true);
			saveBox();
		};
		win.addEventListener('mousemove', move, true);
		win.addEventListener('mouseup', up, true);
	}

	/** Candidate box for one resize gesture, clamped to the panel minimums and
	 * the window (a collapsed panel ignores vertical resize — its height is
	 * auto until re-expanded). */
	function resizeBox(rect, dir, dx, dy, collapsed) {
		const win = state.window;
		const W = Math.max(win?.innerWidth ?? 0, PANEL_MIN.width);
		const H = Math.max(win?.innerHeight ?? 0, PANEL_MIN.height);
		const right = rect.left + rect.width;
		const bottom = rect.top + rect.height;
		let left = rect.left;
		let top = rect.top;
		let width = rect.width;
		let height = rect.height;
		if (dir.includes('e')) {
			width = Math.min(Math.max(width + dx, PANEL_MIN.width), W - left);
		}
		if (dir.includes('w')) {
			width = Math.min(Math.max(width - dx, PANEL_MIN.width), right);
			left = right - width;
		}
		if (!collapsed) {
			if (dir.includes('s')) {
				height = Math.min(Math.max(height + dy, PANEL_MIN.height), H - top);
			}
			if (dir.includes('n')) {
				height = Math.min(Math.max(height - dy, PANEL_MIN.height), bottom);
				top = bottom - height;
			}
		}
		return clampBox({ left, top, width, height });
	}

	function toggleCollapse() {
		state.collapsed = !state.collapsed;
		const panel = state.panel;
		if (!panel) return;
		panel.root.setAttribute('data-collapsed', state.collapsed ? 'true' : 'false');
		if (state.collapsed) {
			panel.root.style.removeProperty('height');
		}
		else {
			const box = currentBox();
			panel.root.style.height = `${box.height}px`;
		}
	}

	function ensurePanel(win) {
		if (state.panel) return state.panel;
		wireTabFollowing();
		const doc = win.document;
		const root = doc.createXULElement('vbox');
		root.id = PANEL_HOST_ID;
		root.setAttribute('class', 'dsh-panel-host');
		const box = doc.createXULElement('vbox');
		box.setAttribute('class', 'dsh-panel');
		box.setAttribute('flex', '1');
		const strip = makeStrip(win, 'panel');
		const browser = makeBrowser(win);
		const grip = doc.createXULElement('hbox');
		grip.setAttribute('class', 'dsh-panel-grip');
		grip.addEventListener('mousedown', (event) => startPanelResize(event, 'se'));
		box.append(strip.root, browser);
		root.append(box, grip);
		// Edge + corner resize handles; the grip above already covers 'se'.
		// Vertical directions are marked so they can be hidden while collapsed.
		for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'sw']) {
			const handle = doc.createXULElement('hbox');
			const vert = dir.includes('n') || dir.includes('s') ? ' dsh-handle-vert' : '';
			handle.setAttribute('class', `dsh-panel-handle dsh-handle-${dir}${vert}`);
			handle.addEventListener('mousedown', (event) => startPanelResize(event, dir));
			root.appendChild(handle);
		}
		doc.documentElement.appendChild(root);
		state.panel = { root, box, strip, browser, grip };
		state.browser = state.browser ?? browser;
		root.setAttribute('hidden', 'true');
		root.style.display = 'none'; // see hidePanel: display beats the UA [hidden] rule
		root.setAttribute('data-collapsed', 'false');
		applyBox(clampBox(currentBox()));
		// Keep the panel on screen when the window shrinks.
		win.addEventListener('resize', () => {
			if (!state.panel || root.getAttribute('hidden') === 'true') return;
			applyBox(clampBox(currentBox()));
		});
		return state.panel;
	}

	function showPanel() {
		const panel = state.panel;
		if (!panel) return;
		panel.root.removeAttribute('hidden');
		// Toggle display explicitly: the UA sheet's [hidden]{display:none} loses
		// to our own `.dsh-panel-host { display: flex }` (author > UA), so the
		// attribute alone never visually hid the panel.
		panel.root.style.display = 'flex';
	}

	function hidePanel() {
		const panel = state.panel;
		if (!panel) return;
		panel.root.setAttribute('hidden', 'true');
		panel.root.style.display = 'none';
	}

	// --- tab -------------------------------------------------------------------

	function ensureTab(win) {
		// Zotero persists tab types and, on restart, calls the restoreState hook
		// of each tab's content type — a missing hook makes restoreState throw
		// (destructuring undefined). parseTabType maps 'dsh-session' → 'dsh';
		// register a no-op so restarts stay clean. Our tab simply doesn't
		// re-open (the wake buttons bring it back in one click).
		try {
			const hooks = win.Zotero_Tabs.tabHooks;
			if (hooks && !hooks.restoreState) hooks.restoreState = {};
			if (hooks?.restoreState && !hooks.restoreState.dsh) {
				hooks.restoreState.dsh = async () => ({ itemID: null });
			}
		}
		catch (e) {
			log('restoreState hook registration failed', e?.message ?? e);
		}
		// Keep the tab out of the saved session: Zotero re-serializes every tab
		// via Zotero_Tabs.getState() on save, and an unknown tab type makes the
		// NEXT startup's restoreState throw (caught, but noisy and it aborts
		// restoring tabs after ours). Filter our type out at the source.
		const tabs = win.Zotero_Tabs;
		if (tabs && !tabs.__dshGetStatePatched) {
			const original = tabs.getState.bind(tabs);
			tabs.getState = () => original().filter(
				(tab) => tab.type !== TAB_TYPE && tab.type !== `${TAB_TYPE}-unloaded`
			);
			tabs.__dshGetStatePatched = true;
		}
		if (state.tab) return state.tab;
		const { id, container } = win.Zotero_Tabs.add({
			type: TAB_TYPE,
			title: 'DSH 会话',
			data: {},
			select: true,
			onClose: () => onTabClosed(),
		});
		const vbox = win.document.createXULElement('vbox');
		vbox.setAttribute('flex', '1');
		vbox.setAttribute('class', 'dsh-session-root');
		const strip = makeStrip(win, 'tab');
		const browser = makeBrowser(win);
		vbox.append(strip.root, browser);
		container.appendChild(vbox);
		state.tab = { id, strip, browser };
		return state.tab;
	}

	/** Zotero_Tabs.close calls onClose synchronously and removes the container
	 * in a later timeout — the browser elements are still alive here, so the
	 * live page can be swapped out before the tab dies. */
	function onTabClosed() {
		const tab = state.tab;
		state.tab = null;
		state.strips = state.strips.filter(s => s !== tab?.strip);
		if (state.browser === tab?.browser) {
			// The user closed the tab while the page lived in it — carry the
			// page back into the panel browser (shown briefly to RECEIVE the
			// swap — layers swapped into a hidden browser never repaint — then
			// re-hidden; the swap itself completed while visible).
			const panel = ensurePanel(state.window);
			showPanel();
			moveLiveSession(panel.browser);
			hidePanel();
			if (state.host === 'tab') state.host = null;
		}
	}

	function closeTabIfAny() {
		if (!state.tab || !state.window) return;
		try {
			state.window.Zotero_Tabs.close(state.tab.id);
		}
		catch (e) {
			log('tab close failed', e?.message ?? e);
		}
	}

	// --- host switching ----------------------------------------------------------

	/** Carry the live dsh page from one host browser to the other without a
	 * reload (browser.swapBrowsers, the tab-detach machinery). */
	function moveLiveSession(targetBrowser) {
		const from = state.browser;
		if (!from || !targetBrowser || from === targetBrowser) {
			if (targetBrowser) state.browser = targetBrowser;
			return;
		}
		const spec = from.currentURI?.spec ?? '';
		try {
			if (typeof from.swapBrowsers === 'function') {
				from.swapBrowsers(targetBrowser);
				state.browser = targetBrowser;
				log(`live session swapped to ${targetBrowser.className || 'browser'} (${spec})`);
				return;
			}
		}
		catch (e) {
			log('swapBrowsers failed', e?.message ?? e);
		}
		// Fallback: plain re-load into the target (page reloads, still correct).
		log('swapBrowsers unavailable — falling back to re-navigation');
		state.browser = targetBrowser;
		if (spec && spec !== 'about:blank') {
			loadBrowser(stripHash(spec), { fragmentOnly: false });
		}
	}

	function setHost(host) {
		const win = state.window ?? Zotero.getMainWindow();
		if (!win) return;
		state.window = win;
		// Adding/closing tabs fires Notifier 'select' events for OTHER tabs
		// (closing ours selects the previous one) — the follow logic must not
		// hijack the conversation mid-switch.
		state.suppressFollow = true;
		try {
			if (host === 'tab') {
				ensurePanel(win); // keeps a warm home for when the tab closes
				ensureTab(win); // adds AND selects → tab container visible
				moveLiveSession(state.tab.browser); // both hosts visible here
				hidePanel();
				state.host = 'tab';
				win.Zotero_Tabs.select(state.tab.id);
			}
			else if (host === 'panel') {
				const panel = ensurePanel(win);
				// Show BEFORE the swap: layers swapped into a display:none
				// remote browser never repaint (blank panel + poisoned future
				// swaps). Hide-after-swap is safe; swap-into-hidden is not.
				showPanel();
				moveLiveSession(panel.browser);
				closeTabIfAny();
				state.host = 'panel';
			}
			else { // hidden — panel browser keeps the page alive in the garage
				const panel = ensurePanel(win);
				showPanel();
				moveLiveSession(panel.browser);
				closeTabIfAny();
				hidePanel();
				state.host = null;
			}
		}
		catch (e) {
			log(`setHost(${host}) failed`, e?.message ?? e);
			toast('DSH', `切换显示模式失败：${e.message}`);
		}
		finally {
			// Release the suppression once any synchronous select events have
			// settled (delay keeps the flag alive past the same-turn triggers).
			void Zotero.Promise.delay(100).then(() => { state.suppressFollow = false; });
		}
		refreshStatus();
		void refreshSelector();
	}

	// --- status / selector ---------------------------------------------------------

	function refreshStatus() {
		if (!state.strips.length) return;
		const sidecar = DSH.Sidecar.state;
		const phase = DSH.Sidecar.getPhase();
		let text = {
			ready: '',
			starting: DSH.Sidecar.withColdHint('dsh 启动中…'),
			installing: DSH.Sidecar.withColdHint('安装 dsh 运行时中…'),
			stopped: 'dsh 已停止',
			failed: 'dsh 启动失败（点击新建会话重试）',
		}[phase] ?? '';
		if (phase === 'ready' && sidecar.attached) text = degraded() ? '外部实例（无桥接，仅对话）' : '外部 dsh 实例';
		else if (phase === 'ready' && degraded()) text = '桥插件未响应（仅对话）';
		for (const strip of state.strips) {
			strip.status.setAttribute('value', text);
		}
	}

	// --- embedded UI driving (hash navigation + ui.state polling) ----------------

	/** Last session-id list the embedded UI reported through the host route. */
	async function pageSessionIds() {
		try {
			const result = await DSH.Sidecar.plugin('ui.state', {}, { timeoutMs: 10_000 });
			const fresh = Date.now() - Number(result?.at ?? 0) < 15_000;
			if (!fresh) return null;
			return Array.isArray(result.sessionIds) ? result.sessionIds : [];
		}
		catch (e) {
			return null;
		}
	}

	/** Wait until the embedded page is reporting (its client plugin is live). */
	async function waitForPage(tries = 90) {
		for (let i = 0; i < tries; i++) {
			const ids = await pageSessionIds();
			if (ids !== null) return true;
			await Zotero.Promise.delay(500);
		}
		return false;
	}

	/**
	 * Make sure the live browser shows the dsh web UI at all. At most one full
	 * load happens per sidecar run, and it uses the LAUNCH URL (with ?token=)
	 * so the REMOTE content process can authenticate on the first request.
	 *
	 * Why not the bare URL: dsh's browser cookie is SameSite=Strict and named
	 * `dsh-auth-<sha256(host:port)>`. `connectAuth` mints it in the CHROME
	 * process via XHR, but a top-level navigation chrome:// → http://127.0.0.1
	 * is cross-site, so the isolated content process never sends a Strict
	 * cookie and dsh answers 401 "dsh web authentication required" — which
	 * used to flash for ~30 s while waitForPage polled before a token fallback.
	 * The launch URL lets dsh verify the token IN the content process, mint the
	 * cookie there, and 303 to "./"; from then on the same-site page is fine.
	 *
	 * Hash safety: this URL carries NO #fragment (the 303 drops the query but
	 * would also drop a fragment). The session hash is attached afterwards by
	 * navigateToSession() with a fragment-only navigation, so nothing is lost.
	 * Cookie bloat is kept in check by connectAuth's pruneAuthCookies().
	 */
	async function ensurePageLoaded() {
		const browser = state.browser;
		if (!browser) return false;
		const apiBase = DSH.Sidecar.state.apiBase;
		if (!apiBase) return false;
		const onOrigin = () => (browser.currentURI?.spec ?? '').startsWith(apiBase);
		if (onOrigin()) {
			if (degraded()) return true; // no client plugin will ever report
			const ids = await pageSessionIds();
			if (ids !== null) return true; // page alive and reporting
		}
		const launchUrl = DSH.Sidecar.state.token
			? (DSH.Sidecar.state.url || `${apiBase}/?token=${encodeURIComponent(DSH.Sidecar.state.token)}`)
			: `${apiBase}/`; // attach URL with no token: existing cookies only
		log(`ensurePageLoaded: full load via launch URL (${degraded() ? 'degraded attach' : 'bundled'})`);
		loadBrowser(launchUrl);
		if (degraded()) {
			// Nothing will ever report back — settle for the document landing.
			for (let i = 0; i < 40 && !onOrigin(); i++) {
				await Zotero.Promise.delay(300);
			}
			await Zotero.Promise.delay(800); // give the SPA a beat to paint
			return onOrigin();
		}
		if (await waitForPage(90)) return true;
		throw new Error('dsh 页面加载超时（嵌入式界面无响应）');
	}

	async function navigateToSession(sessionId) {
		if (!state.browser) return false;
		if (degraded()) {
			await ensurePageLoaded();
			return true;
		}
		// Already on this session (hash equal + the page confirmed it via its
		// last report)? A repeated loadBrowser of the SAME hash fires no
		// hashchange, so the full loop below would just poll for 30 s — skip.
		const targetHash = `#session=${encodeURIComponent(sessionId)}`;
		if ((state.browser.currentURI?.spec ?? '').endsWith(targetHash)) {
			try {
				const ui = await DSH.Sidecar.plugin('ui.state', {}, { timeoutMs: 10_000 });
				if (ui?.lastNav === sessionId) return true;
			}
			catch (e) { /* fall through to the full flow */ }
		}
		const seq = ++state.navSeq;
		state.navigating = true;
		try {
			await ensurePageLoaded();
			// Fragment-only navigation: no reload, the client plugin's hash
			// watcher drives uiWorkspace.openSession inside the SPA.
			const docUrl = stripHash(state.browser.currentURI.spec);
			for (let attempt = 0; attempt < 3; attempt++) {
				if (seq !== state.navSeq) return false; // superseded by a newer switch
				loadBrowser(`${docUrl}#session=${encodeURIComponent(sessionId)}`, { fragmentOnly: true });
				for (let i = 0; i < 20; i++) {
					if (seq !== state.navSeq) return false;
					try {
						const ui = await DSH.Sidecar.plugin('ui.state', {}, { timeoutMs: 10_000 });
						if (ui?.lastNav === sessionId) return true;
					}
					catch (e) { /* page may still be booting its client plugin */ }
					await Zotero.Promise.delay(500);
				}
				log(`session nav not confirmed (attempt ${attempt + 1})`);
			}
			return false;
		}
		finally {
			if (seq === state.navSeq) state.navigating = false;
		}
	}

	/**
	 * Watch for sessions created inside the dsh UI itself (its own new-chat
	 * button). In reader mode a newly created session rebinds the article —
	 * the UI is already showing it, so no navigation happens. Switching to an
	 * existing session via the sidebar never rebinds (by design).
	 */
	function startObserving() {
		if (state.observeTimer || degraded()) return;
		let known = null;
		let busy = false;
		let tick = 0;
		state.observeTimer = setInterval(async () => {
			if (busy || !state.browser || !state.current) return;
			if (state.navigating) return;
			busy = true;
			try {
				// Title watch (every 3rd tick ≈ 6 s): pick up dsh's auto-rename
				// of the current session so the dropdown and tab label follow
				// within seconds of the first exchange.
				if (tick % 3 === 0) await pollCurrentTitle();
				tick++;
				const listed = await pageSessionIds();
				if (!listed || listed.length === 0) return;
				if (known === null) {
					// Baseline tick: adopt whatever exists without acting.
					known = new Set(listed);
					known.add(String(state.current.sessionId));
					return;
				}
				for (const id of listed) {
					if (known.has(id)) continue;
					known.add(id);
					if (state.current.mode === 'reader' && state.current.itemID) {
						// Silent by design: the UI already shows the new session.
						log(`UI-created session ${id} -> rebinding item ${state.current.itemID}`);
						setBinding(state.current.itemID, id);
						state.current.sessionId = id;
						state.current.title = ''; // refilled by the title poll
						void pushChatContext();
						refreshSelector();
					}
					break;
				}
			}
			finally {
				busy = false;
			}
		}, 2000);
	}

	// --- tab following -----------------------------------------------------------
	//
	// While the surface is on screen the conversation follows the ACTIVE Zotero
	// tab: selecting a reader tab shows that article's bound session (silently
	// creating and binding one when absent); selecting the library tab keeps the
	// current conversation but re-targets the guidance context to list mode.
	// Everything here is deliberately SILENT — no rebinding toasts.

	let tabObserverWired = false;

	/** Notifier 'select' events on 'tab' fire on every tab activation, with the
	 * tab type in extraData ([tabID]: {type}); Zotero 10's Zotero_Tabs has no
	 * listener API, and patching select() is unnecessary with this. */
	function wireTabFollowing() {
		if (tabObserverWired) return;
		try {
			Zotero.Notifier.registerObserver(
				{
					notify(event, type, ids, extraData) {
						if (event !== 'select' || type !== 'tab' || !ids?.length) return;
						try {
							void followActiveTab(ids[0], extraData?.[ids[0]]?.type);
						}
						catch (e) {
							log('tab follow dispatch failed', e?.message ?? e);
						}
					},
				},
				['tab'],
				'dsh-in-zotero-tabs'
			);
			tabObserverWired = true;
		}
		catch (e) {
			log('tab observer registration failed', e?.message ?? e);
		}
	}

	/** Follow only while the surface is visible ('panel'/'tab') and no host
	 * switch is in flight: a hidden panel keeps its session, and background
	 * tab switches must not yank the sidecar up or fight the guided
	 * navigation. */
	function followEligible() {
		if (state.suppressFollow) return false;
		return (state.host === 'panel' || state.host === 'tab')
			&& DSH.Sidecar.isReady()
			&& !degraded()
			&& !!state.current;
	}

	async function followActiveTab(tabID, tabType) {
		if (tabType === TAB_TYPE) return; // our own session tab — keep showing
		if (!followEligible()) return;
		if (tabType === 'library') {
			followLibrary();
			return;
		}
		if (typeof tabType === 'string' && tabType.startsWith('reader')) {
			const itemID = Zotero.Reader.getByTabID(tabID)?.itemID
				?? state.window?.Zotero_Tabs?.getTab?.(tabID)?.data?.itemID;
			if (itemID) await followReader(Number(itemID));
		}
	}

	async function followReader(itemID) {
		const seq = ++state.followSeq;
		const cur = state.current;
		if (cur?.mode === 'reader' && cur?.itemID === itemID) return;
		// Follow the article's binding; create (and bind) one silently if none.
		let sessionId = null;
		const bound = getBinding(itemID);
		if (bound && await resolveSession(bound)) {
			sessionId = bound;
		}
		else {
			try {
				sessionId = await createSession(itemTitle(itemID) || 'Zotero 文献会话');
				setBinding(itemID, sessionId);
			}
			catch (e) {
				log('tab-follow session create failed', e?.message ?? e);
				return;
			}
		}
		if (seq !== state.followSeq) return; // another tab was selected meanwhile
		state.current = { mode: 'reader', itemID, sessionId, title: '' };
		log(`tab-follow: reader item ${itemID} -> session ${sessionId}`);
		refreshStatus();
		void refreshSelector();
		void pushChatContext();
		void navigateToSession(sessionId);
	}

	function followLibrary() {
		const cur = state.current;
		if (cur?.mode === 'list') return; // already a library conversation
		// Keep the current conversation — re-creating one per visit would litter
		// the session list; only the guidance context retargets to list mode.
		state.current = { mode: 'list', itemID: null, sessionId: cur?.sessionId ?? null, title: cur?.title ?? '' };
		log('tab-follow: library (context retargeted to list mode)');
		void pushChatContext();
		refreshSelector();
	}

	/** Push the current surface context into the sidecar so the system prompt's
	 * Zotero guidance reflects what the user is actually looking at — keyed by
	 * session id, so every conversation keeps the context it was opened with.
	 * attachmentID = the concrete PDF attachment the reader tools should target
	 * (in reader flows itemID usually already IS the attachment; normalize to
	 * the best attachment so a regular-item id works too). */
	async function pushChatContext() {
		const cur = state.current;
		if (!cur || degraded()) return;
		try {
			const isReader = cur.mode === 'reader' && cur.itemID;
			let attachmentID;
			if (isReader) {
				try {
					const item = Zotero.Items.get(cur.itemID);
					const att = item?.isRegularItem?.() ? await item.getBestAttachment() : item;
					attachmentID = att?.id ?? undefined;
				}
				catch (e) { /* keep undefined */ }
			}
			await DSH.Sidecar.plugin('chat.context', {
				sessionId: cur.sessionId ?? undefined,
				mode: cur.mode === 'reader' ? 'reader' : 'list',
				itemID: cur.itemID ?? undefined,
				attachmentID,
				itemTitle: isReader ? itemTitle(cur.itemID) : undefined,
				itemMeta: isReader ? itemMeta(cur.itemID) : undefined,
			});
		}
		catch (e) {
			log('chat.context push failed', e?.message ?? e);
		}
	}

	function applyCurrentSession(sessionId, { fromUI = false } = {}) {
		if (!state.current) return;
		state.current.sessionId = sessionId;
		state.current.title = ''; // refilled by the title poll
		if (state.current.mode === 'reader' && state.current.itemID) {
			setBinding(state.current.itemID, sessionId);
		}
		void pushChatContext();
		if (!fromUI) {
			void navigateToSession(sessionId);
		}
		refreshSelector();
	}

	async function refreshSelector() {
		if (!state.strips.length) return;
		try {
			const current = state.current?.sessionId ?? '';
			const all = degraded() ? [] : await listSessions();
			// This dropdown is the ZOTERO workspace's conversation list: only its
			// live sessions belong here — not archived ones, not other
			// workspaces' (the desktop dsh shares the engine), and not blank
			// (never-used) placeholders. The session currently on screen always
			// stays visible so the selector never looks empty while showing it.
			const sessions = all.filter(s => s.sessionId === current
				|| (s.zotero === true && s.archived !== true && s.blank !== true));
			for (const strip of state.strips) {
				const { selector, popup } = strip;
				while (popup.firstChild) popup.removeChild(popup.firstChild);
				const doc = popup.ownerDocument;
				let selectedValue = '';
				if (degraded()) {
					const item = doc.createXULElement('menuitem');
					item.setAttribute('label', '（外部实例，无桥接）');
					item.setAttribute('disabled', 'true');
					popup.appendChild(item);
					selector.setAttribute('disabled', 'true');
				}
				else {
					selector.removeAttribute('disabled');
					for (const session of sessions) {
						const item = doc.createXULElement('menuitem');
						item.setAttribute('label', sessionLabel(session));
						item.setAttribute('value', session.sessionId);
						popup.appendChild(item);
						if (session.sessionId === current) selectedValue = session.sessionId;
					}
				}
				selector.value = selectedValue;
				if (!degraded() && state.current?.mode === 'reader' && state.current.itemID) {
					const title = itemTitle(state.current.itemID);
					selector.setAttribute('tooltiptext', `已绑定当前文献《${title}》的会话；新建会话将改绑到新会话`);
				}
				else {
					selector.setAttribute('tooltiptext', '切换会话（也可在左侧 dsh 界面中浏览全部会话）');
				}
			}
		}
		catch (e) {
			log('refreshSelector failed', e?.message ?? e);
		}
	}

	async function newSessionForCurrentMode() {
		try {
			const title = state.current?.mode === 'reader' && state.current.itemID
				? (itemTitle(state.current.itemID) || 'Zotero 文献会话')
				: 'Zotero 会话';
			const sessionId = await createSession(title);
			applyCurrentSession(sessionId);
			state.current.title = title; // known at creation — skip one poll cycle
			void refreshSelector();
			void sweepEmptySessions();
		}
		catch (e) {
			toast('DSH', `新建会话失败：${e.message}`);
		}
	}

	async function switchSession(sessionId) {
		try {
			applyCurrentSession(sessionId);
		}
		catch (e) {
			toast('DSH', `切换会话失败：${e.message}`);
		}
	}

	// --- title watch & empty-session sweep --------------------------------------

	/**
	 * Refresh the current session's stored title from the host list. dsh's
	 * title service renames sessions shortly after their first exchange
	 * ("Zotero会话" → a real summary); without this watch the dropdown and the
	 * tab label would sit on the placeholder forever. Runs on the observer's
	 * tick — cheap, and the next tick retries on failure.
	 */
	async function pollCurrentTitle() {
		const cur = state.current;
		if (!cur?.sessionId || degraded()) return;
		try {
			const row = (await listSessions()).find(s => s.sessionId === cur.sessionId);
			const title = String(row?.title ?? '').trim();
			if (!title || title === cur.title) return;
			cur.title = title;
			void refreshSelector();
			refreshTabTitle(title);
		}
		catch (e) { /* transient — retried on the next tick */ }
	}

	/** Mirror the refreshed session title onto the Zotero tab label (tab host). */
	function refreshTabTitle(title) {
		if (!state.tab || !state.window) return;
		try {
			void state.window.Zotero_Tabs.rename(state.tab.id, `DSH · ${title}`);
		}
		catch (e) {
			log('tab title refresh failed', e?.message ?? e);
		}
	}

	// Every placeholder this plugin ever stamped on a fresh session (historical
	// spellings included — old sessions out there carry both variants).
	const PLACEHOLDER_TITLES = new Set(['Zotero会话', 'Zotero 会话', 'Zotero 文献会话']);

	/**
	 * Archive leftover empty placeholder sessions. Every list-mode open mints
	 * one "Zotero会话"; the unused ones pile up in the dsh sidebar. They carry
	 * no conversation (dsh marks never-used sessions blank), so sweep them
	 * through dsh's own workspace registry — its soft archive, reversible from
	 * the dsh UI. Skips anything an article binding references and the session
	 * currently on screen.
	 */
	async function sweepEmptySessions() {
		if (degraded()) return;
		try {
			const current = state.current?.sessionId ?? '';
			const bound = new Set(Object.values(bindings()).map(String));
			const stale = (await listSessions()).filter(s =>
				s.zotero === true
				&& s.blank === true
				&& s.archived !== true // already swept — don't re-archive
				&& s.sessionId !== current
				&& !bound.has(String(s.sessionId))
				&& (PLACEHOLDER_TITLES.has(String(s.title ?? '').trim())
					|| !String(s.title ?? '').trim()))
				.map(s => s.sessionId);
			if (!stale.length) return;
			await DSH.Sidecar.plugin('session.archive', { sessionIds: stale });
			log(`swept ${stale.length} empty placeholder session(s)`);
			void refreshSelector();
		}
		catch (e) {
			log('empty-session sweep failed', e?.message ?? e);
		}
	}

	// --- entry points ---------------------------------------------------------------

	/** Bring the session surface on screen (panel by default; the tab if that
	 * is the live host). */
	function surface({ preferTab = false } = {}) {
		const win = Zotero.getMainWindow();
		if (!win) return;
		state.window = win;
		if (preferTab || state.host === 'tab') {
			setHost('tab');
		}
		else {
			setHost('panel');
		}
	}

	/**
	 * Open (or reveal) the session surface.
	 * @param {'list'|'reader'} mode
	 * @param {number|null} itemID - the article the reader tab shows.
	 */
	async function open(mode, itemID = null, { onStatus = null } = {}) {
		const win = Zotero.getMainWindow();
		if (!win) return;
		state.window = win;
		ensurePanel(win);
		surface();

		if (degraded()) {
			// External instance without the bridge: chat-only, native UI flow.
			state.current = { mode, itemID, sessionId: null, title: '' };
			refreshStatus();
			void refreshSelector();
			try {
				await ensurePageLoaded();
			}
			catch (e) {
				log('degraded page load failed', e?.message ?? e);
			}
			return;
		}

		// Resolve the session for this open.
		let sessionId = null;
		let title = '';
		if (mode === 'reader' && itemID) {
			const bound = getBinding(itemID);
			if (bound && await resolveSession(bound)) {
				sessionId = bound;
			}
		}
		if (!sessionId) {
			title = mode === 'reader' && itemID
				? (itemTitle(itemID) || 'Zotero 文献会话')
				: 'Zotero 会话';
			sessionId = await createSession(title);
			if (mode === 'reader' && itemID) setBinding(itemID, sessionId);
		}

		state.current = { mode, itemID, sessionId, title };

		// Ground the assistant's system-prompt guidance in what the user is
		// looking at (reader mode names the open article). Await so the very
		// first message of the session already carries the right context.
		await pushChatContext();

		refreshStatus();
		void refreshSelector();
		void sweepEmptySessions(); // clear the placeholders this open displaced
		await navigateToSession(sessionId);
		startObserving();
	}

	/** Open the surface focused on a specific existing session (e.g. the refetch assistant). */
	async function openOnSession(sessionId, { title = null } = {}) {
		const win = Zotero.getMainWindow();
		if (!win) return;
		state.window = win;
		ensurePanel(win);
		surface();
		state.current = { mode: 'list', itemID: null, sessionId, title: title ?? '' };
		void pushChatContext();
		refreshStatus();
		void refreshSelector();
		await navigateToSession(sessionId);
		startObserving();
	}

	function close() {
		setHost(null);
	}

	return { open, openOnSession, close, createSession, listSessions, setHost, state };
})();
