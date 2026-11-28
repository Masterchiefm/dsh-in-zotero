// Zotero in WPS 加载项 — 提示对话框（Zotero 协议的 Document.displayAlert）。
//
// 用 wps.ShowDialog 弹本加载项自带的 dialog.html：原生 alert/confirm 只有两个按钮，
// 而 Zotero 需要「是/否/取消」三键；HTML 对话框还能保证中文按钮文案。对话框页与
// 主页面共享 wps.PluginStorage，参数和结果都经它传递。ShowDialog 对 JS 是非阻塞的，
// 所以这里轮询结果键。
ZW.Dialog = (function () {
	const KEY_PREFIX = 'zotero-wps-dialog.';
	const LABELS = { 0: ['确定'], 1: ['确定', '取消'], 2: ['是', '否'], 3: ['是', '否', '取消'] };
	// 各按钮被点击时回给 Zotero 的值（协议约定：OK_CANCEL 取消=0/确定=1；
	// YES_NO 否=0/是=1；YES_NO_CANCEL 取消=0/否=1/是=2）
	const VALUES = { 0: [1], 1: [1, 0], 2: [1, 0], 3: [2, 1, 0] };
	// 用户没选、直接把对话框关掉时的返回值（一律等同于「取消」）
	const CLOSED = { 0: 1, 1: 0, 2: 0, 3: 0 };
	const ICONS = { 0: '✕', 1: 'ℹ', 2: '⚠' };
	const POLL_MS = 150;
	const MAX_WAIT_MS = 60 * 60 * 1000; // 用户可能离开很久；一小时后按取消处理
	// 对话框页开着时每 250ms 报一次活（一直报到页面卸载）。窗口被宿主直接关掉（标题栏 ×、
	// Alt+F4，或页面没有焦点时回车/Esc 被 WPS 自己处理掉）而结果又没传回来时，只能靠
	// 「心跳停了」知道它不在了。
	const OPEN_GRACE_MS = 4000; // 弹出后这么久还没报过活：没打开，或已经关了
	const GONE_AFTER_MS = 2500; // 报过活之后，心跳停了这么久就算关了（留足存储同步的余量）
	// 答复之后窗口还要再过两三百毫秒才真正消失。这期间请求下一个对话框，WPS 会在拆旧窗口时
	// 把新窗口一起关掉（实机复现：新窗口出现 63ms 后自己消失）。所以下一条提示要等上一个
	// 对话框的页面卸载（pagehide 标记，或心跳停了），再留一段余量。
	const UNLOAD_AFTER_MS = 700;
	const CLOSED_MAX_WAIT_MS = 5000;
	const SETTLE_MS = 500;

	/** 对话框是否已经不在了（纯函数，离线测试用）。aliveSeen = 最近一次看到新心跳的本地时刻，0 = 从未。 */
	function dialogGone(now, shownAt, aliveSeen) {
		return aliveSeen ? now - aliveSeen > GONE_AFTER_MS : now - shownAt > OPEN_GRACE_MS;
	}

	/** 答复之后，对话框的页面是否已经卸载（纯函数，离线测试用）。 */
	function dialogUnloaded(now, aliveSeen, closedFlag) {
		return !!closedFlag || now - aliveSeen > UNLOAD_AFTER_MS;
	}

	// 上一个对话框确认关掉时兑现；连着来的提示框靠它排队
	let previousClosed = Promise.resolve();

	function canUseDialog() {
		try {
			return !!wps && typeof wps.ShowDialog === 'function' && typeof wps.PluginStorage.setItem === 'function';
		}
		catch (e) {
			return false;
		}
	}

	function normalize(icon, buttons) {
		const b = VALUES.hasOwnProperty(buttons) ? Number(buttons) : 0;
		return { icon: ICONS.hasOwnProperty(icon) ? Number(icon) : 0, buttons: b };
	}

	/** 没有 ShowDialog 的环境（理论上只在旧版 WPS 出现）：退到原生 alert/confirm。 */
	function fallback(text, buttons) {
		if (buttons === 0) {
			window.alert(text);
			return Promise.resolve(1);
		}
		if (buttons === 3) {
			// 原生对话框只有两个键：先问「是」，再问「否」；两次都取消即「取消」
			if (window.confirm(text + '\n\n（点「确定」= 是）')) return Promise.resolve(2);
			if (window.confirm(text + '\n\n（点「确定」= 否）')) return Promise.resolve(1);
			return Promise.resolve(0);
		}
		return Promise.resolve(window.confirm(text) ? 1 : 0);
	}

	/**
	 * 弹提示框并等待用户选择。
	 * @param {string} text 提示文字
	 * @param {number} icon 0 停止 / 1 通知 / 2 警告
	 * @param {number} buttons 0 确定 / 1 确定-取消 / 2 是-否 / 3 是-否-取消
	 * @returns {Promise<number>} 被点按钮对应的值（见 VALUES）
	 */
	function alert(text, icon = 0, buttons = 0) {
		const spec = normalize(icon, buttons);
		const message = String(text ?? '');
		if (!canUseDialog()) return fallback(message, spec.buttons);
		const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
		const key = KEY_PREFIX + id;
		const keys = [key, key + '.result', key + '.alive', key + '.closed'];
		const waitPrevious = previousClosed;
		let confirmClosed = () => {};
		previousClosed = new Promise((resolve) => { confirmClosed = resolve; });
		return (async () => {
			// 上一个对话框还没真正关掉就弹下一个，WPS 会把新窗口连带关掉：先等它关掉
			await waitPrevious;
			try {
				wps.PluginStorage.setItem(keys[1], '');
				wps.PluginStorage.setItem(keys[0], JSON.stringify({
					text: message,
					icon: spec.icon,
					buttons: spec.buttons,
					labels: LABELS[spec.buttons],
					values: VALUES[spec.buttons],
					cancel: CLOSED[spec.buttons],
				}));
				wps.ShowDialog(new URL('dialog.html?id=' + id, location.href).href, 'Zotero', 520, 250, true);
			}
			catch (e) {
				confirmClosed();
				return fallback(message, spec.buttons);
			}
			return watchDialog(keys, spec.buttons, confirmClosed);
		})();
	}

	/**
	 * 盯着一个已弹出的对话框：用户答复（或窗口消失）时兑现返回值；之后继续盯到它的页面
	 * 卸载，再留 SETTLE_MS 的余量，才通知下一条提示可以弹。
	 */
	function watchDialog(keys, buttons, confirmClosed) {
		const shownAt = Date.now();
		let lastAlive = null;
		let aliveSeen = 0; // 对话框页最近一次新心跳的本地时刻；0 = 还没见过
		return new Promise((resolve) => {
			let settled = false;
			let settledAt = 0;
			const timer = setInterval(() => {
				let value = null;
				let alive = null;
				let closed = null;
				try {
					value = wps.PluginStorage.getItem(keys[1]);
					alive = wps.PluginStorage.getItem(keys[2]);
					closed = wps.PluginStorage.getItem(keys[3]);
				}
				catch (e) {
					value = null;
				}
				const now = Date.now();
				if (alive && alive !== lastAlive) {
					lastAlive = alive;
					aliveSeen = now;
				}
				if (!settled) {
					const answered = value !== null && value !== undefined && value !== '';
					const timedOut = now - shownAt > MAX_WAIT_MS;
					if (!answered && !dialogGone(now, shownAt, aliveSeen) && !timedOut) return;
					settled = true;
					settledAt = now;
					resolve(answered ? (Number(value) || 0) : CLOSED[buttons]);
				}
				// 答复之后：等窗口真的卸载（页面在 pagehide 时打标记，或心跳停了）再放行下一个
				if (!dialogUnloaded(now, aliveSeen, closed) && now - settledAt <= CLOSED_MAX_WAIT_MS) return;
				clearInterval(timer);
				for (const name of keys) {
					try {
						wps.PluginStorage.removeItem(name);
					}
					catch (e) { /* 残留键无害 */ }
				}
				setTimeout(confirmClosed, SETTLE_MS);
			}, POLL_MS);
		});
	}

	/** 仅通知（等用户点「确定」）。 */
	function info(text) {
		return alert(text, 1, 0);
	}

	return { alert, info, _internals: { dialogGone, dialogUnloaded, VALUES, CLOSED, OPEN_GRACE_MS, GONE_AFTER_MS, UNLOAD_AFTER_MS, CLOSED_MAX_WAIT_MS, SETTLE_MS } };
})();
