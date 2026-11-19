// dsh-in-zotero — the sidecar manager: spawns the dsh web server as a child
// process, seeds its profile with the bundled bridge plugin, parses the
// authenticated URL from stdout, and exposes the RPC/plugin-route clients.

DSH.Sidecar = (() => {
	const { log, prefGet, toast } = DSH.Util;

	// Bundled dsh-plugin payload (shipped inside the xpi, extracted to the
	// data directory, then copied into the sidecar profile's node_modules).
	// Keep in lockstep with ../../dsh-plugin (build-xpi.mjs verifies this list).
	const PLUGIN_FILES = [
		'package.json',
		'cordis.patch.yml',
		'index.js',
		'client.js',
		'src/version.js',
		'src/zoteroClient.js',
		'src/metadata.js',
		'src/prompts.js',
		'src/sessions.js',
		'src/translate.js',
		'src/tools.js',
	];

	ChromeUtils.defineESModuleGetters(globalThis, {
		Subprocess: 'resource://gre/modules/Subprocess.sys.mjs',
	});

	const state = {
		phase: 'stopped', // stopped | installing | starting | ready | failed
		error: '',
		apiBase: '', // http://127.0.0.1:<port>
		url: '', // authenticated URL for the embedded browser
		token: '',
		proc: null,
		startPromise: null,
		listeners: new Set(),
		attached: false, // true = connected to an external running dsh (no child process)
		bridgeOk: null, // null = unknown; false = target lacks the bridge plugin (degraded)
		resolvedMode: '', // effective mode after auto-detection (desktop|custom|bundled|attach)
		desktopPath: '', // detected desktop install (exe path), for display
	};

	function getPhase() {
		return state.phase;
	}

	function onStateChange(fn) {
		state.listeners.add(fn);
		return () => state.listeners.delete(fn);
	}

	function setPhase(phase, error = '') {
		state.phase = phase;
		state.error = error;
		log(`sidecar phase -> ${phase}${error ? ` (${error})` : ''}`);
		for (const fn of state.listeners) {
			try { fn(phase, state); } catch (e) { log('listener failed', e); }
		}
	}

	// --- paths -----------------------------------------------------------------

	function dataDir() {
		return DSH.Util.joinPath(Zotero.Profile.dir, 'dsh-in-zotero');
	}

	function pluginDir() {
		return DSH.Util.joinPath(dataDir(), 'dsh-plugin');
	}

	function runtimeDir() {
		return DSH.Util.joinPath(dataDir(), 'dsh-runtime');
	}

	function dshHome() {
		const override = String(prefGet('dshHome', '') || '').trim();
		if (override) return override;
		return DSH.Util.joinPath(DSH.Util.homeDir(), '.dsh');
	}

	function profileName() {
		return String(prefGet('profileName', 'dsh-in-zotero') || 'dsh-in-zotero');
	}

	function profileDir() {
		return DSH.Util.joinPath(dshHome(), 'profiles', profileName());
	}

	/** Where dsh comes from: auto (detect) | the bundled npm runtime | attach
	 * to a running instance. 'auto' resolves at start time (configured custom
	 * dir → desktop install → bundled runtime; see resolveAutoMode) and never
	 * needs to be stored resolved. Legacy 'desktop'/'custom' selections
	 * normalize to 'auto' — the auto chain resolves them identically, because
	 * the custom dir lives in its own pref either way. */
	function dshMode() {
		const mode = String(prefGet('dshMode', 'auto') || 'auto').toLowerCase();
		if (mode === 'desktop' || mode === 'custom') return 'auto';
		return ['auto', 'bundled', 'attach'].includes(mode) ? mode : 'auto';
	}

	function customDshDir() {
		return String(prefGet('dshCustomDir', '') || '').trim();
	}

	// --- dsh desktop detection --------------------------------------------------

	/** Registry string read that tolerates a missing value — real Uninstall
	 * hives carry plenty of valueless subkeys, and one of them must never abort
	 * the enumeration (the pre-0.1.10 sweep had a bare try/finally around the
	 * DisplayName read: the first valueless key killed the rest of the root). */
	function regString(key, name) {
		try { return String(key.readStringValue(name) ?? ''); }
		catch (e) { return ''; }
	}

	/** Collect DeepSeek exe candidates from the Windows uninstall hive.
	 *
	 * PITFALL: nsIWindowsRegKey.open() is a VOID method in the IDL — it opens
	 * the receiver in place and returns nothing. `key = rk.open(...)` stores
	 * `undefined` and the very next `key.childCount` throws, which the outer
	 * catch swallowed as one log line — the registry channel was dead code on
	 * EVERY machine (0.1.9 symptom: custom-location installs such as
	 * D:\Programs\dsh went undetected even with a perfect HKCU entry).
	 * Statement-style open + use of the receiver itself, matching Zotero's own
	 * WindowsLaunchOnLogin.sys.mjs. */
	function registryDesktopCandidates(out, exeName) {
		const Ci = Components.interfaces;
		const UNINSTALL = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
		// electron-builder's NSIS uninstaller is a 32-bit process: its
		// per-machine entries land in the WOW64 view, which 64-bit Zotero does
		// not see in the native HKLM view.
		const roots = [
			[Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER, UNINSTALL],
			[Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE, UNINSTALL],
			[Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE,
				'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'],
		];
		let scanned = 0;
		for (const [root, path] of roots) {
			const rk = Components.classes['@mozilla.org/windows-registry-key;1']
				.createInstance(Ci.nsIWindowsRegKey);
			try {
				rk.open(root, path, rk.ACCESS_READ); // void — opens rk itself
			}
			catch (e) {
				continue; // root absent (e.g. no per-machine install)
			}
			try {
				const count = rk.childCount;
				for (let i = 0; i < count; i++) {
					let name = '';
					let child = null;
					try { name = rk.getChildName(i); }
					catch (e) { continue; }
					try { child = rk.openChild(name, rk.ACCESS_READ); }
					catch (e) { continue; }
					try {
						scanned++;
						const display = regString(child, 'DisplayName');
						const uninstallStr = regString(child, 'UninstallString');
						if (!/deepseek/i.test(display) && !/deepseek/i.test(uninstallStr) && !/deepseek/i.test(name)) continue;
						const loc = regString(child, 'InstallLocation');
						if (loc) {
							out.push({ path: DSH.Util.joinPath(loc, exeName), origin: 'registry' });
							continue;
						}
						// UninstallString is usually "<dir>\Uninstall <name>.exe" —
						// take the quoted path's parent dir.
						const m = /^"([^"]+Uninstall[^"]*)"/i.exec(uninstallStr.trim()) || /^(\S+Uninstall\S*)/i.exec(uninstallStr.trim());
						if (m) out.push({ path: DSH.Util.joinPath(PathUtils.parent(m[1]), exeName), origin: 'registry' });
					}
					finally { try { child.close(); } catch (e) { /* already closed */ } }
				}
			}
			finally { try { rk.close(); } catch (e) { /* already closed */ } }
		}
		return scanned;
	}

	/** Locate the installed dsh desktop app (DeepSeek Harness). Candidates, in
	 * order: the user-specified desktop dir (pref desktopDir — the manual
	 * fallback for installs no detection can see), the per-user install dir,
	 * %ProgramFiles%, registry uninstall entries (matched loosely on "deepseek"
	 * and also deriving a dir from UninstallString — covers custom installs),
	 * and PATH on Windows; /Applications on macOS. Returns { exe, dir, origin }
	 * or null; the candidate list is kept in lastDetect for debug.detect. */
	let lastDetect = null;

	async function findDesktopInstall() {
		const exeName = 'DeepSeek Harness.exe';
		const candidates = [];
		// Manual override first — a user who pointed us at the dir wins over
		// anything automatic.
		const manual = String(prefGet('desktopDir', '') || '').trim();
		if (manual) candidates.push({ path: DSH.Util.joinPath(manual, exeName), origin: 'manual' });
		let registryScanned = 0;
		if (Zotero.isWin) {
			try {
				const local = Services.dirsvc.get('LocalAppData', Components.interfaces.nsIFile).path;
				candidates.push({ path: DSH.Util.joinPath(local, 'Programs', 'DeepSeek Harness', exeName), origin: 'default' });
			}
			catch (e) {
				const home = DSH.Util.homeDir();
				candidates.push({ path: DSH.Util.joinPath(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', exeName), origin: 'default' });
			}
			try {
				for (const key of ['ProgFiles', 'ProgFiles86']) {
					let dir;
					try { dir = Services.dirsvc.get(key, Components.interfaces.nsIFile).path; }
					catch (e) { continue; }
					candidates.push({ path: DSH.Util.joinPath(dir, 'DeepSeek Harness', exeName), origin: 'default' });
				}
			}
			catch (e) { /* Program Files probes are best-effort */ }
			// Registry sweep: any uninstall entry mentioning "deepseek" — the
			// display name varies across installer versions ("DeepSeek Harness",
			// "DeepSeek-Harness", localized names), so a strict two-word match
			// misses real installs. UninstallString also yields a dir when
			// InstallLocation is absent.
			try {
				registryScanned = registryDesktopCandidates(candidates, exeName);
				const hits = candidates.filter((c) => c.origin === 'registry').length;
				log(`registry sweep: ${registryScanned} uninstall entries scanned, ${hits} deepseek candidate(s)`);
			}
			catch (e) {
				log('registry desktop sweep failed', e?.message ?? e);
			}
			// PATH: a portable copy dropped on PATH is invisible to the registry.
			try {
				const onPath = await Subprocess.pathSearch(exeName);
				if (onPath) candidates.push({ path: onPath, origin: 'path' });
			}
			catch (e) { /* not on PATH */ }
		}
		else {
			candidates.push({ path: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', origin: 'default' });
		}
		const seen = new Set();
		const ordered = [];
		for (const candidate of candidates) {
			if (!candidate.path || seen.has(candidate.path)) continue;
			seen.add(candidate.path);
			ordered.push(candidate);
		}
		let chosen = null;
		for (const candidate of ordered) {
			if (await DSH.Util.pathExists(candidate.path)) {
				chosen = { exe: candidate.path, dir: PathUtils.parent(candidate.path), origin: candidate.origin };
				break;
			}
		}
		lastDetect = { registryScanned, candidates: ordered, chosen };
		return chosen;
	}

	// --- desktop engine (inside app.asar) ---------------------------------------

	// One-entry cache: the asar header is ~6 MB of JSON and both sourceInfo
	// and the start chain may probe it within seconds of each other.
	let asarCache = { key: '', files: null };

	/** Parse an asar archive's header (a JSON directory tree) without Electron.
	 * Layout: u32@0 = 4 (outer pickle size), u32@4 = header size, u32@8 =
	 * payload size, u32@12 = JSON length, JSON text starts at byte 16 (laid
	 * bare by probing the 0.2.2-rc.1 archive; string-grepping the raw header
	 * is unreliable — key order inside the JSON is arbitrary). Returns the
	 * root {files:{…}} tree, or null for unreadable/unknown layouts (never
	 * throws). */
	async function asarFiles(asarPath) {
		try {
			const stat = await IOUtils.stat(asarPath);
			const key = `${asarPath}:${stat.size}:${stat.lastModified}`;
			if (asarCache.key === key) return asarCache.files;
			const head = new DataView((await IOUtils.read(asarPath, { maxBytes: 16 })).buffer);
			const jsonLen = head.getUint32(12, true);
			// Sanity guards against a corrupt or wildly different archive
			// format — treat as "unknown layout", not an error.
			if (head.getUint32(0, true) !== 4 || jsonLen < 2 || jsonLen > 64 * 1024 * 1024) return null;
			const bytes = await IOUtils.read(asarPath, { maxBytes: 16 + jsonLen });
			const tree = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + jsonLen)));
			if (!tree?.files) return null; // not an asar-shaped header
			asarCache = { key, files: tree };
			return tree;
		}
		catch (e) {
			log('asar header parse failed', e?.message ?? e);
			return null;
		}
	}

	/** Does the parsed archive tree contain this inner file? */
	function asarHas(files, innerPath) {
		let node = files;
		for (const segment of String(innerPath).split('/')) {
			if (!segment) continue;
			node = node?.files?.[segment];
			if (!node) return false;
		}
		return !!node;
	}

	/** Engine layouts we can run inside a desktop install, in preference
	 * order. `asar:` entries are verified against the parsed archive header;
	 * `dir:` entries must exist on the real filesystem (unpacked builds). */
	const DESKTOP_ENGINE_LAYOUTS = [
		{ via: 'asar', inner: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' },
		{ via: 'asar', inner: 'node_modules/@deepseek-ai/dsh/lib/bin.js' },
		{ via: 'dir', rel: 'resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' },
		{ via: 'dir', rel: 'resources/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' },
	];

	/** Resolve the dsh core's bin.js inside the desktop install's app.asar.
	 * The asar is NOT a real directory — IOUtils.exists is meaningless for
	 * inner paths — so the header is parsed and the tree walked instead.
	 * Returns { bin, via } or null when this desktop build bundles no engine
	 * we know: auto mode then falls through to the bundled runtime instead of
	 * dying at spawn with a cryptic "dsh 进程提前退出". The returned
	 * <asar>\<inner> path form is what Electron itself accepts as a module
	 * path under ELECTRON_RUN_AS_NODE=1 (the desktop's own Host child works
	 * exactly this way). */
	async function desktopEngine(desktop) {
		if (!desktop) return null;
		const asarPath = DSH.Util.joinPath(desktop.dir, 'resources', 'app.asar');
		let files = null;
		if (await DSH.Util.pathExists(asarPath)) files = await asarFiles(asarPath);
		for (const layout of DESKTOP_ENGINE_LAYOUTS) {
			if (layout.via === 'asar') {
				if (files && asarHas(files, layout.inner)) {
					return { bin: DSH.Util.joinPath(asarPath, layout.inner), via: 'asar' };
				}
			}
			else if (await DSH.Util.pathExists(DSH.Util.joinPath(desktop.dir, layout.rel))) {
				return { bin: DSH.Util.joinPath(desktop.dir, layout.rel), via: 'dir' };
			}
		}
		return null;
	}

	/** Combined detection snapshot for the settings pane / diagnostics. */
	async function sourceInfo() {
		const desktop = await findDesktopInstall();
		const engine = desktop ? await desktopEngine(desktop) : null;
		return {
			mode: dshMode(),
			resolvedMode: state.resolvedMode,
			desktop: desktop
				? { exe: desktop.exe, dir: desktop.dir, origin: desktop.origin, binJs: engine?.bin ?? null, engineVia: engine?.via ?? null, engineOk: !!engine }
				: null,
			bundledReady: await DSH.Util.pathExists(dshBinJsFor('bundled')),
		};
	}

	/** Full detection internals for the debug.detect endpoint — the remote
	 * diagnosis tool for "检测不到 dsh" reports on other machines. */
	async function detectionReport() {
		const info = await sourceInfo();
		let node = null;
		try { node = await nodePath(); }
		catch (e) { node = `NOT FOUND: ${e?.message ?? e}`; }
		return {
			...info,
			node,
			detect: lastDetect,
		};
	}

	function dshBinJsFor(mode) {
		if (mode === 'custom') {
			const dir = customDshDir();
			if (dir) return DSH.Util.joinPath(dir, 'lib', 'bin.js');
		}
		return DSH.Util.joinPath(runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
	}

	function dshBinJs() {
		const mode = state.resolvedMode || dshMode();
		if (mode === 'custom') {
			const dir = customDshDir();
			if (dir) return DSH.Util.joinPath(dir, 'lib', 'bin.js');
		}
		return DSH.Util.joinPath(runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
	}

	// The shared secret the dsh bridge plugin uses to authenticate calls into
	// Zotero's HTTP server. Persisted so restarts keep working.
	function bridgeToken() {
		let token = String(prefGet('bridgeToken', '') || '');
		if (!token) {
			token = Zotero.Utilities.randomString(40, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
			DSH.Util.prefSet('bridgeToken', token);
		}
		return token;
	}

	/** Enumerate the dsh desktop's managed runtime tool dirs:
	 * ~/.dsh/dsh-runtimes/<name>/dependencies/<tool>… (node, pnpm, python). */
	async function runtimeToolPaths(tool, leaf) {
		const out = [];
		if (!Zotero.isWin) return out;
		try {
			const runtimes = DSH.Util.joinPath(dshHome(), 'dsh-runtimes');
			for (const entry of await IOUtils.getChildren(runtimes)) {
				const path = DSH.Util.joinPath(entry, 'dependencies', tool, ...leaf);
				if (await DSH.Util.pathExists(path)) out.push(path);
			}
		}
		catch (e) { /* no dsh-runtimes (desktop not installed / never run) */ }
		return out;
	}

	async function nodePath() {
		const override = String(prefGet('nodePath', '') || '').trim();
		if (override) return override;
		try {
			const found = await Subprocess.pathSearch('node' + (Zotero.isWin ? '.exe' : ''));
			if (found) return found;
		}
		catch (e) {
			log('pathSearch node failed', e);
		}
		const candidates = Zotero.isWin
			? ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe']
			: ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node'];
		for (const candidate of candidates) {
			if (await DSH.Util.pathExists(candidate)) return candidate;
		}
		// The dsh desktop's managed runtime ships a full node (no npm — its
		// toolchain is pnpm) under ~/.dsh/dsh-runtimes; good enough to RUN dsh
		// on machines with no system Node at all.
		for (const managed of await runtimeToolPaths('node', ['bin', 'node.exe'])) {
			return managed;
		}
		throw new Error('找不到 Node.js（dsh 需要 Node ≥ 24.9）。请在关于插件设置中填写 node.exe 路径，或安装 Node.js。');
	}

	// --- seeding ----------------------------------------------------------------

	/** Extract the bundled dsh-plugin payload from the xpi into the data dir. */
	async function seedPlugin(rootURI) {
		const marker = DSH.Util.joinPath(pluginDir(), '.version');
		const wantVersion = `${ctx.VERSION}`;
		try {
			if (await DSH.Util.pathExists(marker)) {
				const have = (await DSH.Util.readTextFile(marker)).trim();
				if (have === wantVersion) return;
			}
		}
		catch (e) { /* reseed below */ }
		for (const rel of PLUGIN_FILES) {
			const target = DSH.Util.joinPath(pluginDir(), rel);
			const response = await fetch(rootURI + 'dsh-plugin/' + rel);
			if (!response.ok) throw new Error(`打包缺失 dsh-plugin/${rel}`);
			await DSH.Util.writeTextFile(target, await response.text());
		}
		await DSH.Util.writeTextFile(marker, wantVersion);
		log(`dsh-plugin payload seeded (${wantVersion})`);
	}

	/** Physical-copy the bridge plugin into the profile's node_modules. */
	async function seedProfile() {
		const dir = profileDir();
		const pkgPath = DSH.Util.joinPath(dir, 'package.json');
		const bridgePath = DSH.Util.joinPath(dir, 'node_modules', 'dsh-in-zotero-bridge');
		const marker = DSH.Util.joinPath(bridgePath, '.version');
		const wantVersion = `${ctx.VERSION}`;
		let fresh = false;
		try {
			if (await DSH.Util.pathExists(marker)) {
				const have = (await DSH.Util.readTextFile(marker)).trim();
				fresh = have === wantVersion;
			}
		}
		catch (e) { /* copy below */ }
		if (!fresh) {
			for (const rel of PLUGIN_FILES) {
				await DSH.Util.writeTextFile(
					DSH.Util.joinPath(bridgePath, rel),
					await DSH.Util.readTextFile(DSH.Util.joinPath(pluginDir(), rel))
				);
			}
			await DSH.Util.writeTextFile(marker, wantVersion);
		}
		if (!(await DSH.Util.pathExists(pkgPath))) {
			await DSH.Util.writeTextFile(pkgPath, JSON.stringify({
				name: `dsh-profile-${profileName()}`,
				private: true,
				dependencies: { 'dsh-in-zotero-bridge': '0.1.0' },
				dsh: {
					profile: {
						bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-in-zotero-bridge'],
					},
				},
			}, null, 2));
			await DSH.Util.writeTextFile(DSH.Util.joinPath(dir, 'cordis.patch.yml'), '[]\n');
			await DSH.Util.writeTextFile(DSH.Util.joinPath(dir, 'pnpm-workspace.yaml'),
				['packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', ''].join('\n'));
			log(`profile seeded at ${dir}`);
		}
	}

	// --- runtime install ----------------------------------------------------------

	async function ensureRuntime(onStatus, manual = false) {
		if (await DSH.Util.pathExists(dshBinJsFor('bundled'))) return;
		const node = await nodePath();
		onStatus?.('首次运行：正在安装 dsh 运行时，约 1-3 分钟…');
		// A manual install from the settings pane must not clobber the phase of
		// an already-running sidecar (only the cold-start path owns that flag).
		if (!manual) setPhase('installing');
		const version = String(prefGet('dshPackageVersion', '') || 'latest');
		const pkg = `@deepseek-ai/dsh@${version}`;
		// npm: "npm-cli.js install pkg --prefix dir"; pnpm (the dsh desktop's
		// managed toolchain) has no --prefix — --dir pins the install root, and
		// its symlinked node_modules is fine (pathExists and node both follow).
		const pm = await packageManagerFor(node);
		const args = pm.tool === 'pnpm'
			? [pm.cli, '--dir', runtimeDir(), 'add', pkg]
			: [pm.cli, 'install', '--no-audit', '--no-fund', '--loglevel=error', pkg, '--prefix', runtimeDir()];
		const registry = String(prefGet('npmRegistry', '') || '').trim();
		if (registry) args.push(`--registry=${registry}`);
		log(`installing dsh runtime: node ${args.join(' ')}`);
		await DSH.Util.writeTextFile(DSH.Util.joinPath(runtimeDir(), 'package.json'),
			JSON.stringify({ name: 'dsh-in-zotero_runtime', private: true }, null, 2));
		const proc = await Subprocess.call({
			command: node,
			arguments: args,
			environment: appendEnv({}),
			environmentAppend: true,
			stderr: 'pipe',
			workdir: runtimeDir(),
		});
		let output = '';
		const drain = async (stream) => {
			let chunk;
			while ((chunk = await stream.readString())) output += chunk;
		};
		const pumps = [drain(proc.stdout), drain(proc.stderr)];
		const exit = await proc.wait();
		await Promise.allSettled(pumps);
		if (exit.exitCode !== 0 || !(await DSH.Util.pathExists(dshBinJs()))) {
			throw new Error(`dsh 运行时安装失败（exit ${exit.exitCode}）：${output.slice(-800)}`);
		}
		log('dsh runtime installed');
	}

	/** The install tool for the bundled runtime: npm-cli.js next to node
	 * (standard Node installs), or the pnpm that ships with the dsh desktop's
	 * managed runtime when node is the npm-less managed build. */
	async function packageManagerFor(node) {
		const npmCli = DSH.Util.joinPath(PathUtils.parent(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
		if (await DSH.Util.pathExists(npmCli)) return { tool: 'npm', cli: npmCli };
		// Sibling of the managed node first (<runtime>/dependencies/pnpm),
		// then any runtime's pnpm.
		try {
			// node.exe lives at <runtime>/dependencies/node/bin/node.exe — three
			// levels up is the shared dependencies dir.
			const deps = PathUtils.parent(PathUtils.parent(PathUtils.parent(node)));
			const sibling = DSH.Util.joinPath(deps, 'pnpm', 'pnpm.cjs');
			if (await DSH.Util.pathExists(sibling)) return { tool: 'pnpm', cli: sibling };
		}
		catch (e) { /* node not under a runtime layout */ }
		for (const pnpm of await runtimeToolPaths('pnpm', ['pnpm.cjs'])) {
			return { tool: 'pnpm', cli: pnpm };
		}
		throw new Error(`找不到 npm（${npmCli}）或 pnpm。请安装完整版 Node.js（自带 npm），或在设置中指定本机 node.exe 路径。`);
	}

	/** Zotero's HTTP server port. `Zotero.Server.port` is a getter that
	 * *throws* while the server is not listening (pref off / failed bind) —
	 * `?.` does not guard getters — so DSH.Util.httpServerPort() returns null
	 * and we fall back to the pref, then the well-known default. Nothing
	 * listens at that address until the server is enabled (index.js's prereq
	 * check offers one-click enable). */
	function zoteroPort() {
		return DSH.Util.httpServerPort() ?? Zotero.Prefs.get('httpServer.port') ?? 23119;
	}

	function appendEnv(extra) {
		const env = {
			DSH_ZOTERO_PORT: String(zoteroPort()),
			DSH_ZOTERO_TOKEN: bridgeToken(),
			DSH_IN_ZOTERO: '1',
			...extra,
		};
		if (Zotero.isWin && !('ComSpec' in env)) {
			// Subprocess on Windows already inherits the essential system vars when
			// environmentAppend is set; nothing else needed.
		}
		return env;
	}

	// --- lifecycle -----------------------------------------------------------------

	/**
	 * Attach mode: adopt an already-running dsh (desktop app, `dsh web`, ...).
	 * No child process is spawned and no profile is seeded — we only exchange
	 * the pasted token for a session cookie and probe whether the instance
	 * carries our bridge plugin (translations/tools degrade gracefully if not).
	 */
	async function startAttached(onStatus) {
		const raw = String(prefGet('attachUrl', '') || '').trim();
		if (!raw) {
			throw new Error('未配置要连接的 dsh 地址。请打开 设置 → dsh-in-zotero，粘贴目标实例的完整 URL（含 ?token=…）。');
		}
		const parsed = (() => {
			try { return new URL(raw); }
			catch (e) { return null; }
		})();
		if (!parsed || !/^https?:$/.test(parsed.protocol)) {
			throw new Error(`无效的 dsh 地址: ${raw}（需要 http(s)://…?token=… 形式）`);
		}
		state.url = raw;
		state.apiBase = `${parsed.protocol}//${parsed.host}`;
		state.token = parsed.searchParams.get('token') ?? '';
		state.attached = true;
		if (!state.token) log('attach URL carries no token — relying on existing cookies only');
		onStatus?.('正在连接 dsh 实例…');
		await connectAuth();
		state.bridgeOk = await probeBridge(15);
		if (!state.bridgeOk) {
			log('attach target has no dsh-in-zotero bridge plugin — degraded mode (chat only)');
		}
	}

	/** Poll the bridge plugin's status op; bundles may register routes a few
	 * seconds after the server prints its URL. */
	async function probeBridge(seconds) {
		for (let i = 0; i < seconds; i++) {
			try {
				const result = await pluginRaw('status', {}, { timeoutMs: 5000 });
				if (result?.ok === true) return true;
			}
			catch (e) { /* retry */ }
			await Zotero.Promise.delay(1000);
		}
		return false;
	}

	/** Resolve the effective source when dshMode is 'auto': a configured local
	 * dsh package dir (the strongest signal — an explicitly filled dir wins
	 * over detection; an invalid/removed dir falls through) → desktop install
	 * (with a verified engine inside its app.asar) → already-installed bundled
	 * runtime → ask the user (whose pick persists: the dir for the custom
	 * choice, the mode for bundled/attach). A desktop without a usable engine
	 * (unknown asar layout) falls through instead of failing at spawn. */
	async function resolveAutoMode(onStatus) {
		if (customDshDir() && (await DSH.Util.pathExists(dshBinJsFor('custom')))) {
			log(`auto: using configured local dsh package at ${customDshDir()}`);
			return 'custom';
		}
		const desktop = await findDesktopInstall();
		if (desktop) {
			state.desktopPath = desktop.exe;
			const engine = await desktopEngine(desktop);
			if (engine) {
				log(`auto: desktop dsh detected at ${desktop.exe} (engine via ${engine.via}: ${engine.bin})`);
				return 'desktop';
			}
			log(`auto: desktop found at ${desktop.exe} but no dsh engine inside its app.asar — falling through`);
		}
		if (await DSH.Util.pathExists(dshBinJsFor('bundled'))) {
			log('auto: no usable desktop dsh, bundled runtime already installed');
			return 'bundled';
		}
		onStatus?.(desktop ? '检测到 dsh 桌面版但未找到其内置内核，需要选择其他来源…' : '未检测到 dsh 桌面版，需要你选择一次来源…');
		const choice = await promptSourceChoice();
		if (!choice) {
			throw new Error('未选择 dsh 来源。可在 Zotero 设置 → dsh-in-zotero 中随时配置。');
		}
		return choice;
	}

	/** The first-run dialog: how should dsh be provided? Persisted on pick. */
	function promptSourceChoice() {
		const win = Zotero.getMainWindow();
		if (!win || typeof Services.prompt?.select !== 'function') return null;
		const title = 'dsh-in-zotero';
		const text = '未检测到本机已安装的 dsh 桌面版。请选择 dsh 的获取方式（此后可在 Zotero 设置 → dsh-in-zotero 中更改）：';
		const choices = [
			'我装了 dsh 桌面版——手动指定它的安装目录',
			'npm 安装内置运行时（自动下载 @deepseek-ai/dsh，开箱即用）',
			'选择本机已有的 dsh 包目录（含 lib\\bin.js 的目录）',
			'连接已在运行的 dsh web 实例（粘贴其带 token 的地址）',
		];
		const selected = { value: 0 };
		// Gecko's xpconnect hides the size_is count argument of
		// nsIPromptService.select — passing the count lands the ARRAY argument
		// slot on a number and throws "Cannot convert primitive JavaScript
		// value into an array arg 3". Try the modern 4-arg form first, then
		// the explicit-count form for any build that still wants it.
		let ok = false;
		try {
			ok = Services.prompt.select(win, title, text, choices, selected);
		}
		catch (e) {
			// Legacy builds that still expose the size_is count: signature is
			// (parent, title, text, list, count, outSelection) — list BEFORE count.
			ok = Services.prompt.select(win, title, text, choices, choices.length, selected);
		}
		const pick = Number(selected.value);
		log(`source choice: ok=${ok} pick=${pick}`);
		if (!ok) return null;
		if (pick === 0) return pickDesktopDir(win);
		if (pick === 1) {
			DSH.Util.prefSet('dshMode', 'bundled');
			return 'bundled';
		}
		if (pick === 3) {
			const url = promptAttachUrl(win);
			if (!url) return null;
			return 'attach';
		}
		// pick === 2 — folder picker for the local dsh package.
		return pickCustomDir(win);
	}

	/** Open a folder picker, resolving to the chosen path (or null on cancel).
	 * The open() callback can be skipped entirely if the window is not
	 * foregrounded; log the outcome so a no-op is diagnosable. */
	function pickFolder(win, title) {
		return new Promise((resolve) => {
			try {
				const fp = Components.classes['@mozilla.org/filepicker;1']
					.createInstance(Components.interfaces.nsIFilePicker);
				// Gecko 128+/Zotero 8: init's arg 0 is a BrowsingContext, not a
				// window — passing the window throws NS_ERROR_ILLEGAL_ARGUMENT.
				// Keep the window form as a fallback for older Gecko builds.
				try {
					fp.init(win?.browsingContext ?? win, title, Components.interfaces.nsIFilePicker.modeGetFolder);
				}
				catch (e) {
					fp.init(win, title, Components.interfaces.nsIFilePicker.modeGetFolder);
				}
				fp.open((result) => {
					const path = result === Components.interfaces.nsIFilePicker.returnOK
						? fp.file?.path ?? null
						: null;
					log(`folder picker result=${result} path=${path ?? '(none)'}`);
					resolve(path);
				});
			}
			catch (e) {
				log(`folder picker failed to open: ${e?.message ?? e}`);
				resolve(null);
			}
		});
	}

	/** Pick the desktop install dir manually (the fallback for installs the
	 * detection can't see — portable copies, non-default locations). The
	 * choice persists in the desktopDir pref, which findDesktopInstall tries
	 * first, and resolves to 'desktop'. */
	async function pickDesktopDir(win) {
		try {
			await Zotero.Promise.delay(300); // let the source-choice modal fully close
			log('pickDesktopDir: opening folder picker');
			const dir = await pickFolder(win, '选择 dsh 桌面版安装目录（含 DeepSeek Harness.exe 的目录）');
			if (!dir) { log('pickDesktopDir: cancelled'); return null; }
			const exe = DSH.Util.joinPath(dir, 'DeepSeek Harness.exe');
			if (!(await DSH.Util.pathExists(exe))) {
				toast('DSH', `所选目录里没有 DeepSeek Harness.exe：${dir}`);
				return null;
			}
			DSH.Util.prefSet('desktopDir', dir);
			log(`pickDesktopDir: selected ${dir}`);
			return 'desktop';
		}
		catch (e) {
			log('desktop dir picker failed', e?.message ?? e);
			return null;
		}
	}

	function promptAttachUrl(win) {
		const input = { value: '' };
		const check = { value: false };
		const ok = Services.prompt.prompt(win,
			'连接 dsh web 实例',
			'粘贴目标实例的完整地址（含 ?token=…，从该实例浏览器地址栏复制）：',
			input, '', check);
		if (!ok) return null;
		const raw = String(input.value || '').trim();
		try {
			const parsed = new URL(raw);
			if (!/^https?:$/.test(parsed.protocol)) throw new Error('protocol');
		}
		catch (e) {
			toast('DSH', '地址无效：需要 http(s)://…?token=… 形式');
			return null;
		}
		DSH.Util.prefSet('attachUrl', raw);
		DSH.Util.prefSet('dshMode', 'attach');
		return raw;
	}

	async function pickCustomDir(win) {
		try {
			await Zotero.Promise.delay(300); // let the source-choice modal fully close
			log('pickCustomDir: opening folder picker');
			const dir = await pickFolder(win, '选择包含 lib/bin.js 的 dsh 包目录');
			if (!dir) { log('pickCustomDir: cancelled'); return null; }
			const bin = DSH.Util.joinPath(dir, 'lib', 'bin.js');
			if (!(await DSH.Util.pathExists(bin))) {
				toast('DSH', `所选目录中没有 lib\\bin.js：${dir}`);
				return null;
			}
			DSH.Util.prefSet('dshCustomDir', dir);
			log(`pickCustomDir: selected ${dir}`);
			// The mode stays 'auto' — the auto chain prefers the configured
			// dir, so the resolved mode is 'custom' on every start.
			return 'custom';
		}
		catch (e) {
			log('folder picker failed', e?.message ?? e);
			return null;
		}
	}

	// Patience note carried by every cold-start status: the FIRST spawn loads
	// the engine bundle (tens of seconds on a cold boot); afterwards the
	// sidecar stays warm and reopen/translate respond instantly.
	const COLD_HINT = '首次启动需加载组件，请多等片刻；之后就快了';
	function withColdHint(text) {
		return `${text}（${COLD_HINT}）`;
	}

	async function ensureStarted({ rootURI, onStatus } = {}) {
		if (state.phase === 'ready') return state;
		if (state.startPromise) return state.startPromise;
		state.startPromise = (async () => {
			try {
				setPhase('starting');
				const step = async (name, fn) => {
					log(`start step: ${name}`);
					try {
						return await fn();
					}
					catch (e) {
						log(`start step ${name} FAILED: ${e?.message ?? e}\n${e?.stack ?? ''}`);
						throw e;
					}
				};
				// Every status of the start sequence is a cold-start moment —
				// carry the patience hint on all of them. The attach path stays
				// unwrapped (it connects to an already-running instance).
				const status = (text) => onStatus?.(withColdHint(text));
				let mode = dshMode();
				if (mode === 'auto') {
					// resolveAutoMode validates the picked source itself
					// (custom dir exists / desktop found) and records
					// state.desktopPath when it lands on the desktop engine.
					mode = await step('resolve-auto', () => resolveAutoMode(onStatus));
				}
				state.resolvedMode = mode;
				if (mode === 'attach') {
					await step('attach', () => startAttached(onStatus));
					setPhase('ready');
					return state;
				}
				status('正在检查 dsh 环境…');
				await step('seedPlugin', () => seedPlugin(rootURI || ctx.rootURI));
				if (mode === 'custom') {
					const bin = dshBinJs();
					if (!(await DSH.Util.pathExists(bin))) {
						throw new Error(`自定义 dsh 目录无效：找不到 ${bin}。请填写包含 lib/bin.js 的 dsh 包目录。`);
					}
				}
				else if (mode === 'desktop') {
					const desktop = await findDesktopInstall();
					if (!desktop) throw new Error('未找到 dsh 桌面版安装目录。请在设置 → dsh-in-zotero 填写桌面版目录，或改用 npm 内置运行时。');
					const engine = await desktopEngine(desktop);
					if (!engine) throw new Error(`dsh 桌面版（${desktop.dir}）内未找到 dsh 内核（app.asar 布局可能已变化）。请改用「npm 内置运行时」，或在设置中指定本机 dsh 包目录。`);
					log(`desktop engine: ${desktop.exe} -> ${engine.bin} (${engine.via})`);
				}
				else {
					await step('ensureRuntime', () => ensureRuntime(status));
				}
				status('正在准备 dsh 配置…');
				await step('seedProfile', () => seedProfile());
				if (mode === 'desktop') {
					await step('spawnDesktop', () => spawnDesktopProcess(status));
				}
				else {
					await step('spawnProcess', () => spawnProcess(status));
				}
				status('正在建立 API 连接…');
				await step('connectAuth', () => connectAuth());
				state.bridgeOk = await probeBridge(30);
				if (!state.bridgeOk) log('bridge plugin did not answer — session window will run degraded');
				setPhase('ready');
				return state;
			}
			catch (e) {
				setPhase('failed', e?.message ?? String(e));
				throw e;
			}
			finally {
				state.startPromise = null;
			}
		})();
		return state.startPromise;
	}

	function spawnProcess(onStatus) {
		return spawnDshProcess(async () => {
			const node = await nodePath();
			const port = Number(prefGet('port', 0) || 0);
			return {
				command: node,
				args: [dshBinJs(), '--profile', profileName(), '--no-open', '--port', String(port)],
			};
		}, onStatus);
	}

	/** The desktop engine: the desktop app's own Electron binary running as a
	 * plain Node runtime (ELECTRON_RUN_AS_NODE=1 — the desktop's Host child
	 * works exactly this way), executing the dsh core packed inside its
	 * app.asar. No separate npm runtime is spawned or needed. */
	function spawnDesktopProcess(onStatus) {
		return spawnDshProcess(async () => {
			const desktop = await findDesktopInstall();
			if (!desktop) throw new Error('未找到 dsh 桌面版安装目录');
			const engine = await desktopEngine(desktop);
			if (!engine) throw new Error(`dsh 桌面版（${desktop.dir}）内未找到 dsh 内核（app.asar 布局可能已变化）`);
			const port = Number(prefGet('port', 0) || 0);
			return {
				command: desktop.exe,
				args: [engine.bin, '--profile', profileName(), '--no-open', '--port', String(port)],
				envExtra: { ELECTRON_RUN_AS_NODE: '1' },
			};
		}, onStatus);
	}

	function spawnDshProcess(makeInvocation, onStatus) {
		return new Promise(async (resolve, reject) => {
			try {
				state.attached = false;
				state.bridgeOk = null;
				const { command, args, envExtra = null } = await makeInvocation();
				log(`spawning dsh: ${command} ${args.join(' ')}`);
				onStatus?.('正在启动 dsh 服务…');
				const proc = await Subprocess.call({
					command,
					arguments: args,
					environment: appendEnv({ DSH_HOME: dshHome(), ...(envExtra ?? {}) }),
					environmentAppend: true,
					stderr: 'pipe',
					workdir: dataDir(),
				});
				state.proc = proc;
				let output = '';
				let settled = false;
				const fail = (message) => {
					if (settled) return;
					settled = true;
					const tail = output.slice(-1000);
					// Rare: the child failed to bind its port. Our spawns use port 0
					// (random) and their own profile, so the running DESKTOP app is
					// NOT a conflict (verified both directions live); this fires only
					// when something grabbed the same address (e.g. a same-port dsh
					// web) or the profile store is locked by a stale same-profile
					// process.
					const busy = /EADDRINUSE|address in use|Another DSH instance/i.test(tail);
					reject(new Error(busy
						? '启动失败：dsh 服务端口绑定失败。本插件与 dsh 桌面版可以同时运行（各自独立端口与 profile），此错误通常是另一个占用了相同地址的 dsh web，或同 profile 的残留进程。请检查后再重试。\n' + tail
						: `${message}\n${tail}`));
				};
				const scan = (chunk) => {
					output += chunk;
					const match = /dsh web: (\S+)/.exec(output);
					if (match && !settled) {
						settled = true;
						state.url = match[1];
						try {
							const parsed = new URL(state.url);
							state.apiBase = `${parsed.protocol}//${parsed.host}`;
							state.token = parsed.searchParams.get('token') ?? '';
						}
						catch (e) {
							settled = false;
							fail(`dsh URL 解析失败: ${state.url}`);
							return;
						}
						resolve();
					}
				};
				const drain = async (stream) => {
					try {
						let chunk;
						while ((chunk = await stream.readString())) scan(chunk);
					}
					catch (e) { /* stream closed */ }
				};
				void drain(proc.stdout);
				void drain(proc.stderr);
				const exit = proc.wait();
				void exit.then(({ exitCode }) => {
					if (!settled) {
						fail(`dsh 进程提前退出（exit ${exitCode}）`);
					}
					else {
						state.proc = null;
						state.url = '';
						state.apiBase = '';
						setPhase('stopped', `dsh 已退出（exit ${exitCode}）`);
					}
				});
				// Startup budget: first boot may install/init the profile.
				Zotero.Promise.delay(180000).then(() => {
					if (!settled) fail('dsh 启动超时（180 秒）');
				});
			}
			catch (e) {
				reject(e);
			}
		});
	}

	// --- API clients -----------------------------------------------------------------

	// --- auth cookie hygiene ----------------------------------------------------
	//
	// dsh mints a NEW `dsh-auth-<random>` cookie on EVERY token exchange (the
	// name is not reused), and Zotero's cookie jar has no port dimension — so
	// every cookie ever minted for ANY local dsh web (this plugin's sidecar,
	// attach-mode targets, desktop app's web UI) rides along on every request
	// to 127.0.0.1. After enough reconnects the Cookie header crosses the
	// server's 16 KiB limit and dsh answers `431 Request Header Fields Too
	// Large` — including /connect itself, so the plugin can never recover on
	// its own. Prune stale dsh-auth cookies before the exchange, keep the jar
	// bounded at one session, and the 431 cannot recur.

	/** Enumerate cookies for a host across Gecko's two API shapes. */
	function hostCookies(host) {
		const jar = Services.cookies;
		let list;
		try { list = jar.getCookiesFromHost(host, {}); }
		catch (e) { list = jar.getCookiesFromHost(host); }
		const out = [];
		if (!list) return out;
		if (typeof list.hasMoreElements === 'function') {
			while (list.hasMoreElements()) out.push(list.getNext());
		}
		else {
			for (const c of list) out.push(c);
		}
		return out;
	}

	/** Drop every dsh-auth cookie. dsh names them `dsh-auth-<sha256(host:port)>`
	 * — a fresh name per launch port, NOT the token — and the remote content
	 * process only ever sends the one cookie matching its own port, so old
	 * ones are pure ballast. Call BEFORE /connect: the exchange request itself
	 * carries the (bloated) jar and would 431 otherwise. */
	function pruneAuthCookies() {
		let host = '';
		try { host = new URL(state.apiBase).hostname; }
		catch (e) { return 0; }
		if (!host) return 0;
		let removed = 0;
		for (const cookie of hostCookies(host)) {
			const name = String(cookie?.name ?? '');
			if (!name.startsWith('dsh-auth-')) continue;
			const attrs = cookie?.originAttributes ?? {};
			// Gecko 140+/Zotero 8: remove(host, name, path, originAttributes) —
			// the old 5-arg form had an isSecure slot that no longer exists;
			// passing `false` there throws NS_ERROR_ILLEGAL_VALUE. Try the
			// modern 4-arg shape first, then legacy shapes for other builds.
			const shapes = [
				() => Services.cookies.remove(cookie.host, name, cookie.path, attrs),
				() => Services.cookies.remove(cookie.host, name, cookie.path, false, attrs),
				() => Services.cookies.remove(cookie.host, name, cookie.path, false),
			];
			let done = false;
			let lastError = null;
			for (const attempt of shapes) {
				try { attempt(); done = true; break; }
				catch (e) { lastError = e; }
			}
			if (done) removed++;
			else log(`dsh-auth cookie remove failed: ${name.slice(0, 18)}…`, lastError?.message ?? lastError);
		}
		if (removed) log(`pruned ${removed} stale dsh-auth cookie(s) for ${host}`);
		return removed;
	}

	/** Exchange the launch token for the API cookie (stored in the cookie jar). */
	async function connectAuth() {
		if (!state.apiBase || !state.token) throw new Error('sidecar 尚未就绪');
		// The jar may already be at the 16 KiB limit from earlier runs — prune
		// BEFORE sending /connect, otherwise the exchange request itself 431s.
		pruneAuthCookies();
		const url = `${state.apiBase}/connect?token=${encodeURIComponent(state.token)}&interactions=none`;
		try {
			await DSH.Util.xhr(url, { method: 'GET', timeoutMs: 15000 });
		}
		catch (e) {
			// The 302 target (/api/remote.mux) may answer non-2xx for a plain GET —
			// the exchange already happened; only a network error is fatal.
			log(`/connect exchange soft-failed: ${e.message}`);
		}
	}

	/** JSON-RPC call on the dsh gateway (session.create, session.list, ...). */
	async function rpc(method, payload = {}, { timeoutMs = 60000 } = {}) {
		if (state.phase !== 'ready') throw new Error('dsh 服务未启动');
		const attempt = async () => DSH.Util.xhr(`${state.apiBase}/api/${method}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ rpcId: DSH.Util.uuid(), method, payload }),
			timeoutMs,
		});
		let { status, text } = await attempt();
		if (status === 401 || status === 431) {
			// 431 = cookie jar overflowed again (e.g. a second local dsh minted
			// cookies meanwhile); 401 = expired. Both recover via re-exchange.
			await connectAuth();
			({ status, text } = await attempt());
		}
		if (status !== 200) throw new Error(`RPC ${method} HTTP ${status}: ${text.slice(0, 300)}`);
		let envelope;
		try { envelope = JSON.parse(text); }
		catch (e) { throw new Error(`RPC ${method} 返回非 JSON: ${text.slice(0, 300)}`); }
		const result = envelope?.result;
		if (!result?.ok) {
			throw new Error(`RPC ${method} 失败: ${result?.error?.code ?? ''} ${result?.error?.message ?? text.slice(0, 200)}`);
		}
		return result.value;
	}

	/**
	 * Call the bundled bridge plugin's route (`POST /api/zotero/rpc`) without
	 * the readiness/bridge guards — used by the startup probe itself.
	 */
	async function pluginRaw(op, payload = {}, { timeoutMs } = {}) {
		// ?? instead of a destructuring default: plugin() forwards an explicit
		// {} which would otherwise leave timeoutMs undefined (no timeout at all).
		timeoutMs ??= 120000;
		const attempt = async () => DSH.Util.xhr(`${state.apiBase}/api/zotero/rpc`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ op, payload }),
			timeoutMs,
		});
		let { status, text } = await attempt();
		if (status === 401 || status === 431) {
			// Startup probe / live calls: recover from an expired session or a
			// cookie-jar overflow the same way (prune + fresh /connect).
			await connectAuth();
			({ status, text } = await attempt());
		}
		if (status !== 200) throw new Error(`plugin ${op} HTTP ${status}: ${text.slice(0, 300)}`);
		let parsed;
		try { parsed = JSON.parse(text); }
		catch (e) { throw new Error(`plugin ${op} 返回非 JSON: ${text.slice(0, 300)}`); }
		if (parsed?.ok === false) throw new Error(parsed?.error?.message ?? `plugin ${op} 失败`);
		return parsed;
	}

	/**
	 * Call the bundled bridge plugin's route (`POST /api/zotero/rpc`).
	 * Returns the plugin's {ok, ...} payload directly.
	 */
	async function plugin(op, payload = {}, opts = {}) {
		if (state.phase !== 'ready') throw new Error('dsh 服务未启动');
		if (state.bridgeOk === false) {
			throw new Error('当前连接的 dsh 实例未安装 dsh-in-zotero 桥插件，无法使用会话管理/翻译/文献工具。请在设置中改用内置运行时，或在目标实例的 profile 里安装 dsh-in-zotero-bridge。');
		}
		return pluginRaw(op, payload, opts);
	}

	/**
	 * Streaming translation via `POST /api/zotero/translate` (NDJSON events).
	 * onEvent receives {type:'thinking'|'answer'|'done'|'error', ...} objects.
	 * opts.model: 'provider/model' (from listModels) or null → dsh's current
	 * model selection. Returns a stop() function.
	 */
	function translateStream(text, onEvent, { thinking = null, model = null } = {}) {
		const controller = { stopped: false, xhr: null };
		const run = (async () => {
			try {
				if (state.phase !== 'ready') throw new Error('dsh 服务未启动');
				let consumed = 0;
				let buffer = '';
				const handle = (fullText) => {
					if (controller.stopped) return;
					if (fullText.length <= consumed) return;
					buffer += fullText.slice(consumed);
					consumed = fullText.length;
					let index;
					while ((index = buffer.indexOf('\n')) >= 0) {
						const line = buffer.slice(0, index).trim();
						buffer = buffer.slice(index + 1);
						if (!line) continue;
						try { onEvent(JSON.parse(line)); }
						catch (e) { log('bad NDJSON line', line.slice(0, 120)); }
					}
				};
				const request = () => DSH.Util.xhr(`${state.apiBase}/api/zotero/translate`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						text,
						...(thinking === null ? {} : { thinking }),
						...(model ? { model } : {}),
					}),
					timeoutMs: 180000,
					onProgress: handle,
				});
				controller.xhr = await request();
				if (!controller.stopped && (controller.xhr.status === 401 || controller.xhr.status === 431)) {
					// Expired session, or the cookie jar bloated again between
					// calls: prune + re-exchange, then restart the stream with a
					// fresh NDJSON consumer so no line is replayed.
					log(`translateStream HTTP ${controller.xhr.status} — re-auth and retry once`);
					await connectAuth();
					consumed = 0;
					buffer = '';
					controller.xhr = await request();
				}
				// Final flush (progress may miss the tail without newlines).
				handle(controller.xhr.text);
				if (controller.xhr.status !== 200) {
					let message = `HTTP ${controller.xhr.status}`;
					try { message = JSON.parse(controller.xhr.text)?.error?.message ?? message; } catch (e) { /* keep */ }
					throw new Error(message);
				}
			}
			catch (e) {
				if (!controller.stopped) onEvent({ type: 'error', message: e?.message ?? String(e) });
			}
		})();
		controller.promise = run;
		return () => {
			controller.stopped = true;
			try { controller.xhr?.abort?.(); } catch (e) { /* already done */ }
		};
	}

	function isReady() {
		return state.phase === 'ready';
	}

	// --- uninstall (cleanup of what the plugin itself installed) -----------------
	//
	// Once the user has the dsh desktop app, the npm runtime this plugin once
	// installed (and any configured local dsh package dir) is dead weight.
	// Removal is deliberately scoped: the dsh program files only — sessions,
	// credentials and model config live in ~/.dsh and stay shared with the
	// desktop app.

	/** Recursive byte count with a file budget so a huge node_modules can't
	 * spin forever (returns whatever was counted by then). */
	async function dirSize(dir, budget = { files: 200_000, bytes: 0 }) {
		try {
			const files = await IOUtils.getChildren(dir, { kind: 'regular' });
			for (const f of files) {
				if (budget.files-- <= 0) return budget.bytes;
				try {
					const st = await IOUtils.stat(f);
					if (typeof st.size === 'number') budget.bytes += st.size;
				}
				catch (e) { /* vanished mid-walk */ }
			}
			const dirs = await IOUtils.getChildren(dir, { kind: 'directory' });
			for (const d of dirs) await dirSize(d, budget);
		}
		catch (e) { /* unreadable — partial count is fine */ }
		return budget.bytes;
	}

	/** Is this path a symlink/junction? nsIFile.isSymlink misses MSYS-made
	 * NTFS links, and IOUtils has no lstat — probe with a one-shot node
	 * process (node was required for any bundled install anyway; without it
	 * we simply can't see links, which only matters for exotic setups).
	 * A dangling link still answers lstat — its existence is exactly what
	 * pathExists-through-link can't report. */
	async function linkInfo(path) {
		let node;
		try {
			node = await nodePath();
		}
		catch (e) {
			return null;
		}
		try {
			const proc = await Subprocess.call({
				command: node,
				arguments: ['-e', 'const fs=require("node:fs");try{const s=fs.lstatSync(process.argv[1]);process.stdout.write(JSON.stringify({symlink:s.isSymbolicLink()}))}catch(e){process.stdout.write(JSON.stringify({symlink:false}))} process.exit(0)', path],
				environmentAppend: true,
				stderr: 'pipe',
			});
			let out = '';
			const drain = async (stream) => {
				try {
					let chunk;
					while ((chunk = await stream.readString())) out += chunk;
				}
				catch (e) { /* closed */ }
			};
			const exit = proc.wait();
			await Promise.allSettled([drain(proc.stdout), drain(proc.stderr), exit]);
			const parsed = JSON.parse(out.trim().split('\n').pop() || '{}');
			if (parsed?.symlink !== true) return null;
			// Best-effort target read via the same node (readlink).
			let target = '';
			try {
				const proc2 = await Subprocess.call({
					command: node,
					arguments: ['-e', 'const fs=require("node:fs");try{process.stdout.write(fs.readlinkSync(process.argv[1])||"")}catch(e){} process.exit(0)', path],
					environmentAppend: true,
					stderr: 'pipe',
				});
				let out2 = '';
				const drain2 = async (stream) => {
					try {
						let chunk;
						while ((chunk = await stream.readString())) out2 += chunk;
					}
					catch (e) { /* closed */ }
				};
				await Promise.allSettled([drain2(proc2.stdout), drain2(proc2.stderr), proc2.wait()]);
				target = out2.trim();
			}
			catch (e) { /* cosmetic */ }
			return { symlink: true, target };
		}
		catch (e) {
			log(`link probe failed (${path})`, e?.message ?? e);
			return null;
		}
	}

	/** Remove a symlink/junction ITSELF, never recursing into its target
	 * (IOUtils.remove(recursive) would follow the link and delete the target's
	 * contents — catastrophic for an aliased directory). rmdirSync removes a
	 * junction/mount point and REFUSES a non-empty real directory — exactly
	 * the safe semantics wanted here; rmSync handles file-type symlinks.
	 * Node's rmSync alone silently no-ops on some junctions (observed live). */
	async function removeLink(path) {
		let ok = false;
		try {
			const node = await nodePath();
			const proc = await Subprocess.call({
				command: node,
				arguments: ['-e', 'const fs=require("node:fs");try{fs.rmdirSync(process.argv[1]);process.exit(0)}catch(e){try{fs.rmSync(process.argv[1],{force:true,recursive:false});process.exit(0)}catch(e2){console.error(e2.code||e2.message);process.exit(1)} }', path],
				environmentAppend: true,
				stderr: 'pipe',
			});
			let exitCode = 0;
			const drain = async (stream) => {
				try {
					let chunk;
					while ((chunk = await stream.readString())) log('link remove stderr:', chunk.trim());
				}
				catch (e) { /* closed */ }
			};
			const exit = proc.wait();
			await Promise.allSettled([drain(proc.stderr), exit.then((info) => { exitCode = info.exitCode; })]);
			ok = exitCode === 0;
		}
		catch (e) {
			log(`link remove failed (${path})`, e?.message ?? e);
		}
		// Verify with the node lstat probe — pathExists follows the link and
		// lies (false) for dangling links, which would mask every failure.
		const still = await linkInfo(path);
		return ok && !still;
	}

	/** IOUtils.remove with retries: on Windows file handles of a just-killed
	 * child can linger for a moment. */
	async function removeDirRetry(path, attempts = 4) {
		for (let i = 0; i < attempts; i++) {
			try {
				if (!(await DSH.Util.pathExists(path))) return true;
				await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
				return !(await DSH.Util.pathExists(path));
			}
			catch (e) {
				log(`remove ${path} attempt ${i + 1} failed`, e?.message ?? e);
				await Zotero.Promise.delay(1200);
			}
		}
		return !(await DSH.Util.pathExists(path));
	}

	/** What the settings pane's cleanup section offers. */
	async function cleanupInfo() {
		const runtime = runtimeDir();
		// pathExists follows links; a dangling symlink reports false. The link
		// itself is still junk worth offering to remove — peek with nsIFile.
		const link = await linkInfo(runtime);
		const runtimeExists = (await DSH.Util.pathExists(runtime)) || !!link;
		const custom = customDshDir();
		return {
			runtime: runtimeExists
				? {
					path: runtime,
					bytes: link ? 0 : await dirSize(runtime),
					symlink: !!link,
					symlinkTarget: link?.target ?? '',
					symlinkBroken: !!link && !(await DSH.Util.pathExists(runtime)),
				}
				: null,
			custom: custom
				? {
					path: custom,
					exists: await DSH.Util.pathExists(custom),
					looksNpm: /[\\/]node_modules([\\/]|$)/i.test(custom),
				}
				: null,
			mode: dshMode(),
			resolvedMode: state.resolvedMode,
			sidecarRunning: !!state.proc,
		};
	}

	async function removeBundledRuntime() {
		const dir = runtimeDir();
		const link = await linkInfo(dir);
		if (!link && !(await DSH.Util.pathExists(dir))) return { ok: true, path: dir, gone: true };
		// The running child would hold locks on its own files (Windows).
		if (state.proc && state.resolvedMode !== 'desktop' && state.resolvedMode !== 'attach') {
			try { stop(); } catch (e) { log('stop before runtime removal failed', e); }
			await Zotero.Promise.delay(800);
		}
		// NEVER recurse through a link — remove the link itself only.
		const gone = link ? await removeLink(dir) : await removeDirRetry(dir);
		if (gone && dshMode() === 'bundled') {
			// Nothing to bundle-spawn anymore — let auto pick desktop/next best.
			DSH.Util.prefSet('dshMode', 'auto');
		}
		return { ok: gone, path: dir, gone, symlink: !!link };
	}

	async function removeCustomDir() {
		const dir = customDshDir();
		if (!dir) return { ok: true, path: null, gone: true };
		if (state.proc && state.resolvedMode === 'custom') {
			try { stop(); } catch (e) { log('stop before custom-dir removal failed', e); }
			await Zotero.Promise.delay(800);
		}
		let gone = true;
		if (await DSH.Util.pathExists(dir)) {
			gone = await removeDirRetry(dir);
		}
		// Clear the reference in every outcome: a dangling dir keeps the auto
		// chain away from desktop detection.
		DSH.Util.prefSet('dshCustomDir', '');
		return { ok: gone, path: dir, gone };
	}

	async function stop() {
		if (state.proc) {
			try { state.proc.kill(); } catch (e) { log('kill failed', e); }
			state.proc = null;
		}
		if (state.attached) {
			state.url = '';
			state.apiBase = '';
			state.token = '';
			state.attached = false;
			state.bridgeOk = null;
		}
		if (state.phase !== 'failed') setPhase('stopped', '已手动停止');
	}

	/** Registered dsh models (for the translate-model picker). Returns
	 * { models: [{id:'provider/model', name}], current } — empty when the
	 * sidecar isn't running or the bridge plugin is missing. */
	async function listModels() {
		if (state.phase !== 'ready') return { models: [], current: null };
		const attempt = async () => DSH.Util.xhr(`${state.apiBase}/api/zotero/models`, {
			method: 'POST',
			timeoutMs: 30_000,
		});
		try {
			let { status, text } = await attempt();
			if (status === 401 || status === 431) {
				await connectAuth();
				({ status, text } = await attempt());
			}
			if (status !== 200) return { models: [], current: null };
			const parsed = JSON.parse(text);
			return {
				models: Array.isArray(parsed?.models) ? parsed.models : [],
				current: parsed?.current ?? null,
			};
		}
		catch (e) {
			log('listModels failed', e?.message ?? e);
			return { models: [], current: null };
		}
	}

	/**
	 * Whether a source is already determined so a start needs NO user
	 * interaction. Used by the background pre-warm to skip first runs that
	 * would otherwise pop the source-choice dialog. Mirrors resolveAutoMode's
	 * detection but never prompts.
	 */
	async function hasReadySource() {
		const mode = dshMode();
		if (mode === 'attach') return !!String(prefGet('attachUrl', '') || '').trim();
		if (mode === 'bundled') return await DSH.Util.pathExists(dshBinJsFor('bundled'));
		// auto: configured custom dir → desktop install (engine verified —
		// a desktop without a usable engine must not count as ready, the
		// pre-warm would just die at spawn) → bundled runtime.
		if (customDshDir() && await DSH.Util.pathExists(dshBinJsFor('custom'))) return true;
		const desktop = await findDesktopInstall();
		if (desktop && (await desktopEngine(desktop))) return true;
		return await DSH.Util.pathExists(dshBinJsFor('bundled'));
	}

	return {
		state, getPhase, isReady, onStateChange, dshMode, sourceInfo, detectionReport,
		dataDir, pluginDir, runtimeDir, dshHome, profileName, bridgeToken,
		nodePath, ensureStarted, ensureRuntime, seedPlugin, seedProfile,
		connectAuth, rpc, plugin, pluginRaw, translateStream, stop, listModels,
		cleanupInfo, removeBundledRuntime, removeCustomDir, withColdHint,
		hasReadySource, pickFolder,
	};
})();
