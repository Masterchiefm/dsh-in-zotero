// Zotero in WPS 加载项 — 与 Zotero 之间的通道 + 一次引用事务的命令循环。
//
// 加载项页面运行在 WPS 自带的 Chromium 里（Origin: file://），而 Zotero 的 HTTP
// 服务器会掐断一切「浏览器发出的」请求，也不回 CORS 头。所以加载项不直接找
// Zotero，而是全部经 dsh-in-zotero 插件自己的桥端点中转：
//     POST /dsh-bridge/wps/ping         探测 + 配对令牌校验
//     POST /dsh-bridge/wps/execCommand  开始一次引用操作
//     POST /dsh-bridge/wps/respond      回传上一条命令的执行结果，领下一条
//     POST /dsh-bridge/wps/heartbeat    事务期间的心跳（WPS 中途关闭时 Zotero 借此收尾）
// 请求体一律是 text/plain 的 JSON（「简单请求」，不触发 CORS 预检），令牌放在查询串里。
// 端点命名与插件其余桥端点一致（/dsh-bridge/<op>，op 用点号分段）。
//
// 一次事务 = execCommand 的响应带来第一条命令，此后每条 respond 带回上一条命令的
// 执行结果、领回下一条，直到收到 Document.complete。命令由 ZW.Doc 执行（文档操作）。

ZW.Protocol = (function () {
	const BRIDGE = '/dsh-bridge/wps.';
	const PORTS = [23119, 23120, 23121, 23122, 23123, 23124, 23125, 23126, 23127, 23128, 23129, 23130, 23131];
	const HEARTBEAT_MS = 5000;
	const MAX_STEPS = 200000; // 防死循环：正常事务只有几十到几百步
	let base = null; // 已确认可达的桥基址（http://127.0.0.1:端口）
	let busy = false;
	let beatTimer = null;
	let authFailed = false;

	function config() {
		return window.ZOTERO_WPS_CONFIG || {};
	}

	function parse(text) {
		try {
			const value = JSON.parse(text);
			return value && typeof value === 'object' ? value : null;
		}
		catch (e) {
			return null;
		}
	}

	/** POST 到桥端点。网络层失败返回 { status: 0 }，交由调用方归类成用户能看懂的话。 */
	function post(path, payload, timeoutMs) {
		const token = String(config().token || '');
		const url = base + BRIDGE + path + '?t=' + encodeURIComponent(token);
		const controller = typeof AbortController === 'function' ? new AbortController() : null;
		let timer = null;
		const options = {
			method: 'POST',
			mode: 'cors',
			headers: { 'Content-Type': 'text/plain' },
			body: JSON.stringify(payload === undefined ? {} : payload),
		};
		if (controller) {
			options.signal = controller.signal;
			if (timeoutMs) timer = setTimeout(() => controller.abort(), timeoutMs);
		}
		return fetch(url, options)
			.then((res) => res.text().then((text) => ({ status: res.status, text })))
			.catch(() => ({ status: 0, text: '' }))
			.finally(() => {
				if (timer) clearTimeout(timer);
			});
	}

	/** 找到 Zotero 桥：上次用过的地址优先，再从 Zotero 的默认端口段往后扫。 */
	async function discover() {
		authFailed = false;
		if (!String(config().token || '')) return false;
		const origins = [];
		if (base) origins.push(base);
		for (const port of PORTS) {
			const origin = 'http://127.0.0.1:' + port;
			if (origins.indexOf(origin) < 0) origins.push(origin);
		}
		for (const origin of origins) {
			base = origin;
			const r = await post('ping', {}, 1500);
			if (r.status === 403) authFailed = true;
			if (r.status === 200 && /"ok"\s*:\s*true/.test(r.text)) return true;
		}
		base = null;
		return false;
	}

	/** 桥返回的错误体 → 中文说明；不是结构化错误时用 fallback。 */
	function explain(r, fallback) {
		const body = parse(r.text);
		const message = body && body.error && body.error.message ? String(body.error.message) : '';
		if (message) return message;
		if (r.status === 503) return 'Zotero 正在处理另一个引用操作（可能是在 Word 里），请等它完成后再试。';
		return fallback + (r.status ? `（HTTP ${r.status}）` : '');
	}

	const MESSAGES = {
		unpaired: '这个加载项还没有和 Zotero 配对。请在 Zotero 里打开「设置 → dsh-in-zotero → WPS 文字引用」，点「一键修复 WPS Zotero 引用」，然后重启 WPS。',
		expired: 'WPS 引用加载项与 Zotero 插件的配对已失效（重装过 Zotero 或本插件后会出现）。请在 Zotero 的「设置 → dsh-in-zotero」里点「一键修复 WPS Zotero 引用」，然后重启 WPS。',
		offline: '无法连接 Zotero。请确认 Zotero 正在运行；如果它刚被重装、或关闭了本地通信服务，也会出现这个提示——在 Zotero 的「设置 → dsh-in-zotero」里点「一键修复 WPS Zotero 引用」通常可以解决。',
	};

	function startHeartbeat(docId) {
		stopHeartbeat();
		beatTimer = setInterval(() => {
			post('heartbeat', { docId }, 4000);
		}, HEARTBEAT_MS);
	}

	function stopHeartbeat() {
		if (beatTimer) clearInterval(beatTimer);
		beatTimer = null;
	}

	/** 跑一次引用操作（addEditCitation / refresh / …）。所有失败都以中文提示框收尾。 */
	async function run(command) {
		if (busy) {
			await ZW.Dialog.alert('上一个引用操作还在进行：请在 Zotero 或弹出的对话框里完成或取消它。', 2, 0);
			return;
		}
		busy = true;
		let stepError = null;
		try {
			if (!String(config().token || '')) throw new Error(MESSAGES.unpaired);
			if (!(await discover())) throw new Error(authFailed ? MESSAGES.expired : MESSAGES.offline);
			ZW.Doc.begin();
			const first = await ZW.Doc.dispatch('Application.getActiveDocument', []);
			const docId = first.documentID;
			startHeartbeat(docId); // 从发出请求起就报活：Zotero 那边可能先要忙几秒
			let r = await post('execCommand', { command, docId, client: { name: 'zotero-in-wps', version: String(config().addonVersion || '') } });
			if (r.status !== 200) throw new Error(explain(r, 'Zotero 未能开始这次引用操作。'));
			for (let step = 0; step < MAX_STEPS; step++) {
				const message = parse(r.text);
				if (!message || typeof message.command !== 'string') throw new Error('Zotero 返回了无法识别的数据。');
				if (message.command === 'Document.complete') return; // 事务正常结束
				let result;
				try {
					// 命令失败不中断循环：把错误交回 Zotero，由它决定提示什么、何时收尾
					result = await ZW.Doc.dispatch(message.command, message.arguments);
				}
				catch (e) {
					result = { error: 'Error', message: String((e && e.message) || e), stack: String((e && e.stack) || '') };
				}
				r = await post('respond', result === undefined ? null : result);
				if (r.status === 0) throw new Error(MESSAGES.offline);
				if (r.status === 409) return; // Zotero 侧事务已不在（例如加载项刚被重新加载）
				if (r.status !== 200) throw new Error(explain(r, '与 Zotero 的通信中断。'));
			}
			throw new Error('这次引用操作的步骤数超出预期，已中止。');
		}
		catch (e) {
			stepError = e;
		}
		finally {
			stopHeartbeat();
			ZW.Doc.end();
			busy = false;
		}
		await ZW.Dialog.alert(String((stepError && stepError.message) || stepError), 0, 0);
	}

	return { run, discover, isBusy: () => busy, _internals: { explain, MESSAGES } };
})();
