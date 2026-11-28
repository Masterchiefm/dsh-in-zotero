// dsh-in-zotero — WPS 文字（WPS Writer）里的 Zotero 引用。
//
// 两件事：
//   1. 安装器：把随 xpi 打包的 WPS JS 加载项（content/wps-addon/）部署到 WPS 的
//      jsaddons 目录并登记。WPS 个人版没有 VBA、装不了 Zotero.dotm，所以这里走
//      WPS 官方的 JS 加载项通道——零 VBA、零联网、零管理员权限。加载项用 Zotero
//      自己的 HTTP 集成协议（agent='http'）对接，写出的文档与 Word 版同构。
//   2. 桥接：加载项页面跑在 WPS 自带的 Chromium 里，Zotero 的 HTTP 服务器会把
//      「浏览器发出的」请求直接掐断且不回 CORS 头，所以加载项只与本插件的
//      /dsh-bridge/wps.* 端点说话，由这里中转给 Zotero 的集成端点。
//
// 部署形态（实测 WPS 12.1 个人版，与官方 wpsjs build --exe 自解压包的写法一致）：
//   %APPDATA%\Kingsoft\wps\jsaddons\zotero-in-wps_<版本>\{index.html,ribbon.xml,js\…}
//   %APPDATA%\Kingsoft\wps\jsaddons\publish.xml
//     <jsplugins><jsplugin name="zotero-in-wps" type="wps" url="zotero-in-wps_<版本>"
//       version="<版本>" enable="enable_dev" install="null" customDomain=""/></jsplugins>
// WPS 首次加载（以及文件内容变化后）会弹一次「是否信任 / 已被修改，是否继续加载」，
// 这是它自己的安全机制——所以安装器是幂等的：内容没变就不重写任何文件。

DSH.WPS = (() => {
	const { log } = DSH.Util;

	const ADDON_NAME = 'zotero-in-wps';
	const ADDON_VERSION = '1.0.0';
	const ADDON_SOURCE = ctx.rootURI + 'content/wps-addon/';
	// 随 xpi 打包、原样复制的加载项文件（改动 wps-addon/ 目录时同步；build-xpi.mjs 会核对）
	const ADDON_FILES = [
		'index.html', 'ribbon.xml', 'dialog.html',
		'js/html.js', 'js/dialog.js', 'js/document.js', 'js/protocol.js', 'js/ribbon.js',
		'images/about.svg', 'images/annotation.svg', 'images/bibliography.svg', 'images/citation.svg',
		'images/note.svg', 'images/prefs.svg', 'images/refresh.svg', 'images/unlink.svg', 'images/zotero.svg',
	];
	const CONFIG_FILE = 'js/config.js'; // 装机时生成（内含配对令牌），不在 ADDON_FILES 里
	const PUBLISH_FILE = 'publish.xml';
	const AUTH_FILE = 'authaddin.json';
	const WPS_EXE_REL = ['office6', 'wps.exe'];
	// 加载项可触发的 Zotero 集成命令（Zotero.Integration.Interface 上的方法名）
	const COMMANDS = ['addEditCitation', 'addEditBibliography', 'addNote', 'addAnnotation', 'setDocPrefs', 'refresh', 'removeCodes'];
	const STALE_MS = 25000; // 加载项每 5s 心跳一次；连续 5 次没消息且 Zotero 没开着自己的窗口 = WPS 已经不在了

	// ---------------------------------------------------------------- 路径与检测

	function appDataDir() {
		try {
			const env = Services.env.get('APPDATA');
			if (env) return env;
		}
		catch (e) { /* fall through */ }
		return Services.dirsvc.get('AppRegD', Components.interfaces.nsIFile).path;
	}

	function envDir(name) {
		try {
			return Services.env.get(name) || '';
		}
		catch (e) {
			return '';
		}
	}

	function jsaddonsDir() {
		return DSH.Util.joinPath(appDataDir(), 'Kingsoft', 'wps', 'jsaddons');
	}

	function addonDirName() {
		return `${ADDON_NAME}_${ADDON_VERSION}`;
	}

	function addonDir() {
		return DSH.Util.joinPath(jsaddonsDir(), addonDirName());
	}

	/** 注册表字符串值；键或值不存在返回 ''（readStringValue 对缺失值会抛）。 */
	function regString(root, path, name) {
		const rk = Components.classes['@mozilla.org/windows-registry-key;1']
			.createInstance(Components.interfaces.nsIWindowsRegKey);
		try {
			rk.open(root, path, rk.ACCESS_READ); // void——原地打开 rk 本身
			return String(rk.readStringValue(name) ?? '');
		}
		catch (e) {
			return '';
		}
		finally {
			try { rk.close(); } catch (e) { /* 已关闭 */ }
		}
	}

	function versionValue(version) {
		return String(version || '').split('.').map((part) => Number(part) || 0);
	}

	function newer(a, b) {
		const va = versionValue(a);
		const vb = versionValue(b);
		for (let i = 0; i < Math.max(va.length, vb.length); i++) {
			if ((va[i] || 0) !== (vb[i] || 0)) return (va[i] || 0) > (vb[i] || 0);
		}
		return false;
	}

	/**
	 * 检测 WPS：注册表 InstallRoot（个人版装在 %LOCALAPPDATA%，企业版常在
	 * %ProgramFiles%），找不到再扫常见安装目录。返回 { dir, exe, version, origin } 或 null。
	 */
	async function detectWps() {
		const Ci = Components.interfaces;
		const COMMON = 'Software\\Kingsoft\\Office\\6.0\\Common';
		const candidates = [];
		const push = (dir, version, origin) => {
			if (dir && !candidates.some((c) => c.dir.toLowerCase() === dir.toLowerCase())) candidates.push({ dir, version: version || '', origin });
		};
		for (const [root, path] of [
			[Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER, COMMON],
			[Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE, COMMON],
			[Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE, 'Software\\WOW6432Node\\Kingsoft\\Office\\6.0\\Common'],
		]) {
			push(regString(root, path, 'InstallRoot'), regString(root, path, 'Version'), 'registry');
		}
		// 兜底：安装根目录下通常按版本号分子目录，取最高的那个
		for (const base of [
			DSH.Util.joinPath(envDir('LOCALAPPDATA'), 'Kingsoft', 'WPS Office'),
			DSH.Util.joinPath(envDir('ProgramFiles'), 'WPS Office'),
			DSH.Util.joinPath(envDir('ProgramFiles'), 'Kingsoft', 'WPS Office'),
			DSH.Util.joinPath(envDir('ProgramFiles(x86)'), 'Kingsoft', 'WPS Office'),
		]) {
			if (!base || !(await DSH.Util.pathExists(base))) continue;
			push(base, '', 'default-location');
			let children = [];
			try {
				children = await IOUtils.getChildren(base, { kind: 'directory' });
			}
			catch (e) {
				children = [];
			}
			for (const child of children) {
				const name = PathUtils.filename(child);
				if (/^\d+\.\d+/.test(name)) push(child, name, 'default-location');
			}
		}
		candidates.sort((a, b) => (newer(b.version, a.version) ? 1 : newer(a.version, b.version) ? -1 : 0));
		for (const candidate of candidates) {
			const exe = DSH.Util.joinPath(candidate.dir, ...WPS_EXE_REL);
			if (await DSH.Util.pathExists(exe)) return { ...candidate, exe };
		}
		return null;
	}

	// ---------------------------------------------------------------- 文件工具

	async function fetchText(url) {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`插件包里缺少 ${url}`);
		return response.text();
	}

	/** 读出目录下全部文件 { 相对路径: 文本 }；目录不存在返回 null。 */
	async function readTree(dir) {
		if (!(await DSH.Util.pathExists(dir))) return null;
		const out = {};
		const walk = async (path, rel) => {
			for (const child of await IOUtils.getChildren(path)) {
				const name = PathUtils.filename(child);
				const childRel = rel ? `${rel}/${name}` : name;
				const stat = await IOUtils.stat(child);
				if (stat.type === 'directory') await walk(child, childRel);
				else {
					try {
						out[childRel] = await IOUtils.readUTF8(child);
					}
					catch (e) {
						out[childRel] = null; // 非 UTF-8：一定与期望内容不同
					}
				}
			}
		};
		await walk(dir, '');
		return out;
	}

	async function listDir(dir) {
		try {
			return await IOUtils.getChildren(dir);
		}
		catch (e) {
			return [];
		}
	}

	async function removeDir(path) {
		if (!(await DSH.Util.pathExists(path))) return;
		// Windows 上刚被占用的句柄可能晚一点才释放，重试几次
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
				if (!(await DSH.Util.pathExists(path))) return;
			}
			catch (e) { /* retry */ }
			await Zotero.Promise.delay(500);
		}
	}

	async function readText(path) {
		try {
			return await IOUtils.readUTF8(path);
		}
		catch (e) {
			return '';
		}
	}

	// ---------------------------------------------------------------- publish.xml
	//
	// WPS 的加载项登记表。根元素 <jsplugins> 下是自闭合的 <jsplugin …/>（离线/
	// 在线加载项）和 <jspluginonline …/>（调试模式）。这个文件里没有 Zotero 的
	// DOM 解析器可用（bootstrap 沙箱没有 DOMParser），所以用正则做增删。

	/** 文件里所有自闭合的加载项元素与注释，按原顺序。 */
	function publishItems(text) {
		const items = [];
		const re = /<!--[\s\S]*?-->|<([A-Za-z][\w:-]*)(?=[\s/>])[^>]*?\/>/g;
		for (const match of String(text ?? '').matchAll(re)) {
			if (match[1] && !/^jsplugin/i.test(match[1])) continue; // 只认加载项元素
			items.push(match[0]);
		}
		return items;
	}

	function itemAttribute(item, name) {
		const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(item);
		return match ? match[1] : null;
	}

	function addonElement(version = ADDON_VERSION, name = ADDON_NAME) {
		return `<jsplugin name="${name}" type="wps" url="${name}_${version}" version="${version}" enable="enable_dev" install="null" customDomain=""/>`;
	}

	/** 把 publish.xml 改写成「我们的登记在最前 + 其他加载项的登记原样保留」。 */
	function rewritePublish(text, element, name = ADDON_NAME) {
		const kept = publishItems(text).filter((item) => itemAttribute(item, 'name') !== name);
		const items = element ? [element].concat(kept) : kept;
		return items.length
			? '<jsplugins>\n    ' + items.join('\n    ') + '\n</jsplugins>\n'
			: '<jsplugins>\n</jsplugins>\n';
	}

	function findPublishEntry(text, name = ADDON_NAME) {
		for (const item of publishItems(text)) {
			if (itemAttribute(item, 'name') === name) {
				return { url: itemAttribute(item, 'url'), version: itemAttribute(item, 'version'), raw: item };
			}
		}
		return null;
	}

	// ---------------------------------------------------------------- 安装 / 卸载 / 状态

	function token() {
		return DSH.Sidecar.bridgeToken();
	}

	function configSource() {
		return '// 由 dsh-in-zotero 的安装器（DSH.WPS.install）在装机时生成：token 是加载项与 Zotero 桥之间的配对令牌。\n'
			+ `window.ZOTERO_WPS_CONFIG = ${JSON.stringify({ token: token(), addonVersion: ADDON_VERSION, pluginVersion: String(ctx.VERSION) })};\n`;
	}

	/** 加载项目录应当具有的全部文件 { 相对路径: 文本 }。 */
	async function wantedFiles() {
		const want = {};
		for (const rel of ADDON_FILES) want[rel] = await fetchText(ADDON_SOURCE + rel);
		want[CONFIG_FILE] = configSource();
		return want;
	}

	function sameTree(have, want) {
		if (!have) return false;
		const haveKeys = Object.keys(have);
		const wantKeys = Object.keys(want);
		return haveKeys.length === wantKeys.length && wantKeys.every((rel) => have[rel] === want[rel]);
	}

	/** 本插件名下、却不该再存在的目录：旧版本号目录和写了一半的临时目录。 */
	async function staleDirs() {
		const prefix = `${ADDON_NAME}_`;
		const keep = addonDirName();
		const out = [];
		for (const child of await listDir(jsaddonsDir())) {
			const name = PathUtils.filename(child);
			if (name.indexOf(prefix) === 0 && name !== keep) out.push(child);
		}
		return out;
	}

	async function overview() {
		const [wps, have, want, publishText, stale] = await Promise.all([
			detectWps(), readTree(addonDir()), wantedFiles(), readText(DSH.Util.joinPath(jsaddonsDir(), PUBLISH_FILE)), staleDirs(),
		]);
		const entry = findPublishEntry(publishText);
		const filesOk = sameTree(have, want);
		const registered = !!entry && entry.url === addonDirName() && entry.version === ADDON_VERSION;
		const issues = [];
		if (!wps) issues.push('没有检测到 WPS 文字');
		else {
			if (!have) issues.push('WPS 引用加载项尚未安装');
			else if (!filesOk) issues.push('WPS 引用加载项的文件缺失、被改动或版本过旧');
			if (!registered) issues.push('WPS 的加载项登记（publish.xml）缺失或失效');
		}
		if (stale.length) issues.push('残留着旧版本的加载项目录');
		return {
			ok: true,
			healthy: issues.length === 0,
			issues,
			wps: wps ? { version: wps.version || '', dir: wps.dir } : null,
			addon: { name: ADDON_NAME, version: ADDON_VERSION, dir: addonDir() },
			installed: !!have,
			upToDate: filesOk,
			registered,
		};
	}

	async function status() {
		return overview();
	}

	/**
	 * 安装 / 修复。文件内容已经正确且登记无误时什么都不动（WPS 对内容变化会重新
	 * 弹「是否继续加载」，无谓的重写等于每次修复都让用户多点一次）。
	 * @param {{force?: boolean}} [options] force 为 true 时无条件重写
	 */
	async function install({ force = false } = {}) {
		const before = await overview();
		if (!before.wps) {
			return {
				ok: false,
				code: 'wps/not-installed',
				healthy: false,
				message: '没有检测到 WPS 文字（WPS Writer）。请先安装 WPS：https://www.wps.cn ，装好后再点一次修复。',
				status: before,
			};
		}
		if (!force && before.healthy) {
			return { ...before, changed: false, restartNeeded: false, message: 'WPS 引用加载项状态正常，无需修复。' };
		}
		const dir = addonDir();
		const tmp = `${dir}.tmp`;
		const want = await wantedFiles();
		// 先写临时目录再换名：写一半的目录不会被 WPS 加载
		await removeDir(tmp);
		for (const [rel, text] of Object.entries(want)) {
			await DSH.Util.writeTextFile(DSH.Util.joinPath(tmp, ...rel.split('/')), text);
		}
		await removeDir(dir);
		// Gecko 140 的 IOUtils 没有 rename；move 到一个尚不存在的路径就是改名。
		// noOverwrite：目录没删干净时宁可报错，也不悄悄盖上去。
		IOUtils.move(tmp, dir, { noOverwrite: true });
		for (const stale of await staleDirs()) await removeDir(stale);
		const publishPath = DSH.Util.joinPath(jsaddonsDir(), PUBLISH_FILE);
		await DSH.Util.writeTextFile(publishPath, rewritePublish(await readText(publishPath), addonElement()));
		const after = await overview();
		log(`wps addon installed: ${dir} (healthy=${after.healthy})`);
		return {
			...after,
			ok: after.healthy,
			changed: true,
			reinstall: before.installed,
			message: after.healthy
				? (before.installed ? '已修复 WPS 引用加载项。' : '已为 WPS 文字安装 Zotero 引用加载项。')
				: `修复未完全生效：${after.issues.join('；')}`,
		};
	}

	async function uninstall() {
		const dir = addonDir();
		await removeDir(dir);
		for (const stale of await staleDirs()) await removeDir(stale);
		const publishPath = DSH.Util.joinPath(jsaddonsDir(), PUBLISH_FILE);
		if (await DSH.Util.pathExists(publishPath)) {
			await DSH.Util.writeTextFile(publishPath, rewritePublish(await readText(publishPath), null));
		}
		await forgetAuthorization();
		return { ok: true, message: '已卸载 WPS 引用加载项。', status: await overview() };
	}

	/** 从 WPS 的授权记录（authaddin.json）里抹掉本加载项的条目。记录值是 WPS 加密
	 * 存放的，这里只按 name 精确匹配删除，不解释其他内容。 */
	async function forgetAuthorization() {
		const path = DSH.Util.joinPath(jsaddonsDir(), AUTH_FILE);
		const text = await readText(path);
		if (!text) return;
		let data;
		try {
			data = JSON.parse(text);
		}
		catch (e) {
			return;
		}
		let changed = false;
		for (const section of Object.values(data)) {
			if (!section || typeof section !== 'object') continue;
			for (const [key, value] of Object.entries(section)) {
				if (value && typeof value === 'object' && value.name === ADDON_NAME) {
					delete section[key];
					changed = true;
				}
			}
			// namelist 是全部记录 id 的列表；只有它恰好只含本加载项时才动它
			if (changed && typeof section.namelist === 'string' && !Object.keys(section).some((key) => key !== 'namelist' && section[key] && typeof section[key] === 'object')) {
				delete section.namelist;
			}
		}
		if (changed) await DSH.Util.writeTextFile(path, JSON.stringify(data, null, 4) + '\n');
	}

	// ---------------------------------------------------------------- 桥接端点

	const CORS_HEADERS = {
		'Content-Type': 'application/json; charset=utf-8',
		'Access-Control-Allow-Origin': '*', // 加载项页面的 Origin 是 file://，只能用通配
		'Cache-Control': 'no-store',
	};

	// --- 集成事务中转 ---------------------------------------------------------
	//
	// Zotero 的 HTTP agent 把「要文字处理器执行的命令」写进上一个 HTTP 请求的响应，
	// 再用下一个 respond 请求领取结果，两个端点靠 HTTPIntegrationClient 上两个全局
	// 槽位（sendResponse / deferredResponse）对接；而「事务进行中」标志只有 Zotero
	// 自己充当客户端时才复位——远程客户端第二条命令起永远拿到 503。所以这里不把
	// 请求原样转给那两个端点，而是自己做槽位的管理者：事务状态记在 tx 里，
	// Document.complete 之后主动复位，并靠加载项的心跳识别「WPS 中途被关掉」留下
	// 的僵尸事务。

	let tx = null;

	function httpAgent() {
		return Zotero.HTTPIntegrationClient;
	}

	function isComplete(body) {
		try {
			return JSON.parse(body)?.command === 'Document.complete';
		}
		catch (e) {
			return false;
		}
	}

	function finish() {
		httpAgent().inProgress = false;
		resetCommandChain();
		tx = null;
	}

	/** 把 HTTP agent 的命令链重置回可用状态。死掉的流程会把 sendCommandPromise 留在
	 * 「永远等不到应答」的那条命令上，而 HTTP 集成把每条新命令都 .then() 在链尾——
	 * 不重置的话，下一个事务的每条命令都永远发不出来（实机：WPS 崩溃后集成卡死）。 */
	function resetCommandChain() {
		const client = httpAgent();
		if (!client) return;
		try {
			client.sendCommandPromise = Zotero.Promise.resolve();
			client.deferredResponse = null;
		}
		catch (e) { /* 旧版 Zotero 没有这些槽位 */ }
	}

	/** 加载项已经不在了（心跳断绝且 Zotero 没开着引文/首选项窗口）：收拾它留下的全局状态。
	 * 旧事务的执行流程永远停在自己那条 deferred 上，不会再被唤醒，也就不会再碰共享槽位。 */
	function abandon() {
		try {
			Zotero.Integration.currentSession?.progressBar?.hide(true);
		}
		catch (e) { /* 进度条已经不在 */ }
		if (!Zotero.Integration.currentWindow) {
			Zotero.Integration.currentDoc = false;
			Zotero.Integration.currentSession = null;
		}
		resetCommandChain();
		tx = null;
	}

	function isStale() {
		return !!tx && Date.now() - tx.beatAt > STALE_MS && !Zotero.Integration.currentWindow;
	}

	function parseBody(data) {
		// 与 Zotero 端点一致：请求体就是结果的 JSON 文本，能解析就解析，否则原样
		try {
			return JSON.parse(data);
		}
		catch (e) {
			return data;
		}
	}

	// 中转处理器的统一返回形态：{ status, body, raw }。raw 表示 body 已是 JSON 文本——
	// 集成命令由 Zotero 自己序列化，不能再包一层。
	const errorReply = (status, code, message) => ({ status, body: { ok: false, error: { code, message } }, raw: false });
	const relay = ([status, body]) => ({ status, body, raw: true }); // Zotero 给加载项的下一条命令
	const busyResponse = (message) => errorReply(503, 'zotero/busy', message);

	async function proxyExecCommand(data) {
		if (!httpAgent()) {
			return errorReply(500, 'zotero/unsupported', '当前 Zotero 版本没有 HTTP 集成接口，无法与 WPS 加载项对接。');
		}
		const payload = typeof data === 'string' ? parseBody(data) : data;
		const command = String(payload?.command ?? '');
		if (!COMMANDS.includes(command)) {
			return errorReply(400, 'zotero/invalid', `不支持的引用操作：${command}`);
		}
		if (tx) {
			if (!isStale()) return busyResponse('Zotero 正在处理另一个引用操作（可能在 Word 或另一个 WPS 窗口里），请等它完成后再试。');
			log('wps integration: previous transaction lost its client, abandoning it');
			abandon();
		}
		if (Zotero.Integration.currentDoc) {
			// Word 版插件的事务在跑：交由 execCommand 处理只会弹 Zotero 自己的原生提示，直接回绝
			return busyResponse('Zotero 正在处理 Word 里的引用操作，请等它完成后再试。');
		}
		const client = httpAgent();
		client.inProgress = true;
		const first = Zotero.Promise.defer();
		let sent = false;
		client.sendResponse = (code, type, body) => {
			if (sent) {
				log('wps integration: extra sendResponse before first respond, dropped', String(body).slice(0, 120));
				return;
			}
			sent = true;
			log(`wps integration: first command -> ${String(body).slice(0, 100)}`);
			first.resolve([code, body]);
		};
		tx = { docId: String(payload.docId ?? ''), beatAt: Date.now(), run: null };
		log(`wps integration: ${command} (${tx.docId})`);
		const run = Zotero.Integration.execCommand('http', command, payload.docId);
		tx.run = run;
		const settle = () => first.resolve(null); // 流程结束却没向加载项发过任何命令
		run.then(settle, (e) => {
			log('wps integration: execCommand rejected', e?.message ?? e);
			settle();
		});
		const result = await first.promise;
		if (!result) {
			log('wps integration: execCommand ended without sending any command');
			finish();
			return busyResponse('Zotero 没有开始这次引用操作（可能弹出了提示或已被取消），请稍后重试。');
		}
		return relay(result);
	}

	async function proxyRespond(data) {
		if (!tx || !httpAgent()) {
			return errorReply(409, 'zotero/no-transaction', '没有进行中的引用操作。');
		}
		tx.beatAt = Date.now();
		const client = httpAgent();
		const next = Zotero.Promise.defer();
		let sent = false;
		client.sendResponse = (code, type, body) => {
			if (sent) return;
			sent = true;
			next.resolve([code, body]);
		};
		const settle = () => next.resolve(null);
		tx.run.then(settle, settle);
		const deferred = client.deferredResponse;
		if (deferred) {
			const payload = parseBody(data);
			if (payload && typeof payload === 'object' && payload.error) {
				const error = new Zotero.Exception.Alert(String(payload.message ?? payload.error));
				error.stack = typeof payload.stack === 'string' ? payload.stack : JSON.stringify(payload.stack ?? '');
				deferred.reject(error);
			}
			else {
				deferred.resolve(payload);
			}
		}
		const result = await next.promise;
		if (!result) {
			// 流程已结束却没发 Document.complete（标准流程之外的收尾）：替它结束，加载项才不会干等
			const docId = tx.docId;
			finish();
			return relay([200, JSON.stringify({ command: 'Document.complete', arguments: [docId] })]);
		}
		if (isComplete(result[1])) finish();
		return relay(result);
	}

	function endpoint(handler) {
		const e = function () {};
		e.prototype = {
			supportedMethods: ['POST'],
			supportedDataTypes: '*', // 加载项发 text/plain（简单请求，不触发 CORS 预检）
			// 加载项页面的 UA 以 Mozilla/ 开头且带 Origin，Zotero 默认把它当浏览器
			// 请求直接断开——这里是给自家加载项开的门，靠查询串里的配对令牌把关
			allowRequestsFromUnsafeWebContent: true,
			init: async ({ data, searchParams }) => {
				const provided = searchParams ? searchParams.get('t') : '';
				if (!provided || provided !== token()) {
					Zotero.debug('dsh-in-zotero: wps bridge call with bad token');
					return [403, CORS_HEADERS, JSON.stringify({ ok: false, error: { code: 'zotero/bad-token', message: 'WPS 加载项与 Zotero 插件的配对已失效，请在 Zotero 设置里点「一键修复 WPS Zotero 引用」。' } })];
				}
				try {
					// handler 返回 { status, body, raw }；raw 表示 body 已是 JSON 文本
					// （集成命令由 Zotero 序列化，不能再包一层）
					const { status, body, raw } = await handler(data);
					return [status, CORS_HEADERS, raw ? body : JSON.stringify(body)];
				}
				catch (e) {
					log('wps bridge op failed', e?.message ?? e, (e?.stack ?? '').slice(0, 400));
					return [500, CORS_HEADERS, JSON.stringify({ ok: false, error: { code: 'zotero/error', message: e?.message ?? String(e) } })];
				}
			},
		};
		return e;
	}

	const ENDPOINTS = {
		// 探测 + 配对校验；busy 让加载项能在开事务前就知道 Zotero 是否被占用
		'wps.ping': () => ({ status: 200, body: { ok: true, zotero: Zotero.version, addon: ADDON_VERSION, plugin: String(ctx.VERSION), busy: !!tx }, raw: false }),
		'wps.execCommand': proxyExecCommand,
		'wps.respond': proxyRespond,
		'wps.heartbeat': () => {
			if (tx) tx.beatAt = Date.now();
			return { status: 200, body: { ok: true }, raw: false };
		},
	};

	const PREFIX = '/dsh-bridge/';

	function register() {
		unregister();
		for (const [name, handler] of Object.entries(ENDPOINTS)) {
			Zotero.Server.Endpoints[PREFIX + name] = endpoint(handler);
		}
	}

	function unregister() {
		for (const name of Object.keys(ENDPOINTS)) {
			delete Zotero.Server.Endpoints[PREFIX + name];
		}
		tx = null;
	}

	return {
		ADDON_NAME, ADDON_VERSION, ADDON_FILES, COMMANDS,
		detectWps, jsaddonsDir, addonDir,
		status, install, uninstall,
		register, unregister,
		_internals: { rewritePublish, findPublishEntry, addonElement, publishItems, sameTree }, // 离线测试用
	};
})();
