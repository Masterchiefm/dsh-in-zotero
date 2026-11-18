// dsh-in-zotero — weekly update checker. Once a week (and ~90s after
// startup, so it never competes with boot) it asks GitHub for the latest
// release and, when a newer version exists, downloads the .xpi — GitHub
// first, then public CDN mirrors (GitHub is slow or blocked on some
// networks) — and installs it through Zotero's own addon installer.

DSH.Update = (() => {
	const { log, toast } = DSH.Util;

	const REPO = 'Masterchiefm/dsh-in-zotero';
	const CHECK_INTERVAL = 7 * 24 * 60 * 60 * 1000; // one week
	const FIRST_CHECK_DELAY = 90 * 1000;

	const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

	// Download sources, tried in order. The CDN entries are ghproxy-style
	// mirrors that prefix the GitHub URL — they come and go, so failures just
	// fall through to the next source.
	const downloadUrls = (version, file) => {
		const direct = `https://github.com/${REPO}/releases/download/v${version}/${file}`;
		return [
			direct,
			`https://ghfast.top/${direct}`,
			`https://gh-proxy.com/${direct}`,
		];
	};

	function enabled() {
		return !!DSH.Util.prefGet('autoUpdate', true);
	}

	function lastCheck() {
		return Number(DSH.Util.prefGet('lastUpdateCheck', 0)) || 0;
	}

	function markChecked() {
		DSH.Util.prefSet('lastUpdateCheck', Date.now());
	}

	/** Compare dotted numeric versions ('0.1.2'); true when b > a. */
	function isNewer(a, b) {
		const pa = String(a ?? '').split('.').map(n => parseInt(n, 10) || 0);
		const pb = String(b ?? '').split('.').map(n => parseInt(n, 10) || 0);
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
			if (diff !== 0) return diff > 0;
		}
		return false;
	}

	async function fetchLatestRelease() {
		const response = await fetch(LATEST_API, {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-in-zotero-updater' },
		});
		if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
		const release = await response.json();
		const tag = String(release?.tag_name ?? '').replace(/^v/i, '');
		const asset = (release?.assets ?? []).find(a => new RegExp(`dsh-in-zotero-${tag}\\.xpi$`, 'i').test(String(a?.name ?? '')));
		return {
			version: tag,
			name: String(release?.name ?? ''),
			url: String(release?.html_url ?? ''),
			file: asset ? String(asset.name) : `dsh-in-zotero-${tag}.xpi`,
		};
	}

	/** Download through the source list; returns the raw bytes. */
	async function downloadXpi(version, file) {
		const sources = downloadUrls(version, file);
		let lastError = null;
		for (const url of sources) {
			try {
				log('downloading update from', url);
				const response = await fetch(url, { 'User-Agent': 'dsh-in-zotero-updater' });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const buffer = await response.arrayBuffer();
				if (buffer.byteLength < 10_000) throw new Error(`下载内容过小（${buffer.byteLength} 字节），疑似失败页`);
				return { buffer, url };
			}
			catch (e) {
				lastError = e;
				log('download source failed:', url, e?.message ?? e);
			}
		}
		throw lastError ?? new Error('全部下载源都失败了');
	}

	/** Install a downloaded .xpi through Gecko's AddonManager — the same
	 * installer Zotero's own plugin UI uses (Zotero's plugins.js hooks the
	 * AddonManager listeners that shut down the old half and start the new
	 * one). */
	async function installXpi(buffer, file) {
		const path = PathUtils.join(PathUtils.tempDir, file);
		await IOUtils.write(path, new Uint8Array(buffer));
		const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
		const fileObj = Components.classes['@mozilla.org/file/local;1']
			.createInstance(Components.interfaces.nsIFile);
		fileObj.initWithPath(path);
		const install = await AddonManager.getInstallForFile(fileObj);
		if (!install) throw new Error('无法解析插件包（xpi 损坏或与当前 Zotero 不兼容）');
		if (install.state === AddonManager.STATE_DOWNLOAD_FAILED || install.state === AddonManager.STATE_INSTALL_FAILED) {
			throw new Error(`插件包不可安装：${install.error ?? '未知错误'}`);
		}
		await install.install();
		return path;
	}

	/**
	 * Check for a newer release; optionally download + install it.
	 * @param {object} [options]
	 * @param {boolean} [options.install=false] download & install when newer
	 * @param {string}  [options.forceVersion] pretend the installed version is
	 *        this (debug/testing only)
	 * @returns {object} result summary
	 */
	async function check({ install = false, forceVersion = null } = {}) {
		const current = String(forceVersion ?? ctx.VERSION);
		const release = await fetchLatestRelease();
		const updateAvailable = isNewer(current, release.version);
		const result = {
			ok: true,
			current,
			latest: release.version,
			updateAvailable,
			releaseUrl: release.url,
			installed: false,
		};
		if (!updateAvailable || !install) {
			return result;
		}
		toast('DSH 更新', `发现新版本 ${release.version}，正在下载…`);
		const { buffer } = await downloadXpi(release.version, release.file);
		await installXpi(buffer, release.file);
		result.installed = true;
		toast('DSH 更新', `已下载并安装 ${release.version}，重启 Zotero 后生效`);
		return result;
	}

	/** The weekly loop: fire-and-forget, all failures silent (a log line
	 * only) — update checking must never disturb normal usage. */
	async function maybeCheckWeekly() {
		if (!enabled()) return;
		if (Date.now() - lastCheck() < CHECK_INTERVAL) return;
		try {
			markChecked();
			const result = await check({ install: true });
			if (result.updateAvailable) {
				log(`weekly check: ${result.current} → ${result.latest}${result.installed ? ' (installed)' : ''}`);
			}
			else {
				log(`weekly check: up to date (${result.current})`);
			}
		}
		catch (e) {
			log('weekly update check failed', e?.message ?? e);
		}
	}

	function register() {
		// First check shortly after startup, then at most once a week.
		Zotero.Promise.delay(FIRST_CHECK_DELAY).then(() => { void maybeCheckWeekly(); }).catch(() => {});
	}

	return { register, check, maybeCheckWeekly };
})();
