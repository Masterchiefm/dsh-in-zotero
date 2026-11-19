// dsh-in-zotero — shared utilities. Loaded first; every later module hangs
// its namespace off the shared `DSH` object created here.

var DSH = {};

DSH.Util = (() => {
	// The canonical namespace — the same one the settings pane's `preference`
	// bindings and prefs.js defaults use. Before 0.8.6 the runtime read the
	// bare branch below instead, so pane checkboxes (translateThinking!) wrote
	// prefs the runtime never saw; prefGet migrates those values over once.
	const PREF_BRANCH = 'extensions.zotero.dsh-in-zotero.';
	const LEGACY_BRANCH = 'dsh-in-zotero.';

	function prefGet(name, fallback) {
		try {
			const full = PREF_BRANCH + name;
			const legacyFull = LEGACY_BRANCH + name;
			// One-time carry-over from the pre-0.8.6 bare branch (bindings,
			// panelBox, bridgeToken, translateAuto — the values that matter).
			// Gated on prefHasUserValue: prefs.js ships DEFAULTS under the new
			// branch, and a bare getValue would return those and shadow the
			// real legacy user value forever (translateAuto/panelBox hit this).
			//
			// The carry-over must CONSUME the legacy value (clearUserPref) —
			// keeping it made the migration an endless resurrection: setting a
			// pref to a value EQUAL to its default clears the user value again
			// (Gecko dedup), the next read re-migrated the stale legacy value
			// over it, and prefs could never leave their legacy state — the
			// 「自动」translate toggle snapped back to ON on every click.
			if (!Services.prefs.prefHasUserValue(full)
				&& Services.prefs.prefHasUserValue(legacyFull)) {
				const legacy = Zotero.Prefs.get(legacyFull, true);
				if (legacy !== undefined) {
					let migrated = false;
					try {
						Zotero.Prefs.set(full, legacy, true);
						migrated = true;
					}
					catch (e) { /* type mismatch — keep reading legacy */ }
					// Only consume after a successful carry-over; a failed write
					// keeps the legacy value so nothing is lost.
					if (migrated) {
						try { Services.prefs.clearUserPref(legacyFull); } catch (e) { /* cosmetic */ }
					}
					return legacy;
				}
			}
			else if (Services.prefs.prefHasUserValue(legacyFull)) {
				// The canonical branch already has the say — consume the stale
				// legacy copy NOW so it can never resurrect: when a pref is
				// later set to a value equal to its default, Gecko drops the
				// user value, and without this the very next read would
				// re-migrate the legacy value over the user's choice.
				try { Services.prefs.clearUserPref(legacyFull); } catch (e) { /* cosmetic */ }
			}
			const value = Zotero.Prefs.get(full, true);
			return value === undefined ? fallback : value;
		}
		catch (e) {
			return fallback;
		}
	}

	function prefSet(name, value) {
		Zotero.Prefs.set(PREF_BRANCH + name, value, true);
	}

	/** A JSON object pref, with a safe default. */
	function prefGetJSON(name, fallback) {
		const raw = prefGet(name, undefined);
		if (typeof raw !== 'string' || raw === '') return fallback;
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : fallback;
		}
		catch (e) {
			return fallback;
		}
	}

	function prefSetJSON(name, value) {
		Zotero.Prefs.set(PREF_BRANCH + name, JSON.stringify(value), true);
	}

	function log(...args) {
		Zotero.debug('dsh-in-zotero: ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	}

	function uuid() {
		return Zotero.Utilities.randomString
			? Zotero.Utilities.randomString(32) + '-' + Date.now()
			: String(Math.random()) + String(Date.now());
	}

	/** Home directory of the current OS user (Services.dirsvc "Home"). */
	function homeDir() {
		if (typeof PathUtils?.homeDir === 'string') return PathUtils.homeDir;
		return Services.dirsvc.get('Home', Components.interfaces.nsIFile).path;
	}

	/** Absolute-path join; splits slash-bearing segments (PathUtils.join rejects
	 * components that contain separators, e.g. 'src/tools.js'). */
	function joinPath(...parts) {
		const segments = [];
		for (const part of parts) {
			for (const segment of String(part).split('/')) {
				if (segment !== '') segments.push(segment);
			}
		}
		return PathUtils.join(...segments);
	}

	async function pathExists(path) {
		try {
			return await IOUtils.exists(path);
		}
		catch (e) {
			return false;
		}
	}

	/** Port of Zotero's HTTP server while it is actually listening, else null.
	 * `Zotero.Server.port` is a getter that *throws* when the server never
	 * started (httpServer.enabled off, or a failed bind) — `?.` guards null
	 * objects, not throwing getters. The server is the tools' only callback
	 * channel (/dsh-bridge/*); index.js's startup check offers one-click
	 * enable when this returns null. */
	function httpServerPort() {
		try {
			return Zotero.Server?.port ?? null;
		}
		catch (e) {
			return null; // 'Server not initialized'
		}
	}

	async function readTextFile(path) {
		return IOUtils.readUTF8(path);
	}

	async function writeTextFile(path, text) {
		await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true });
		await IOUtils.writeUTF8(path, text);
	}

	/** Convert a Windows/any path to a file:// URL usable from fetch(). */
	function pathToURI(path) {
		return Services.io.newURI(Services.io.newFileURI(new Components.File(path)).spec).spec;
	}

	/** Progress toast helper. Returns { update(text), done(text), error(text) }.
	 *
	 * Zotero's own close timer is cancelled whenever the mouse merely touches
	 * the toast, and its mouse-out re-arm is broken upstream — and our floating
	 * panel lives in the same bottom-right corner the toasts tile into, so the
	 * cursor crosses the toast on every open. Arm our own fallback timer that
	 * nothing but an explicit update/done/error (or a click) postpones. */
	function toast(headline, line, opts = {}) {
		try {
			const pw = new Zotero.ProgressWindow({ closeOnClick: true });
			pw.changeHeadline(headline);
			if (line) pw.addLines(line);
			pw.show();
			let generation = 0;
			const arm = (ms) => {
				const gen = ++generation;
				pw.startCloseTimer(ms);
				void Zotero.Promise.delay(ms + 500).then(() => {
					if (generation !== gen) return;
					try { pw.close(); } catch (e) { /* already closed */ }
				});
			};
			arm(opts.ms || 8000);
			return {
				update(text) {
					try { pw.addLines(text); } catch (e) { /* closed */ }
					arm(90_000); // progress may legitimately go quiet for a while
				},
				done(text) {
					try { pw.addLines(text || '完成'); } catch (e) { /* closed */ }
					arm(3500);
				},
				error(text) {
					try { pw.addDescription(String(text)); } catch (e) { /* closed */ }
					arm(10_000);
				},
			};
		}
		catch (e) {
			DSH.Util.log('toast failed', e);
			return { update() {}, done() {}, error() {} };
		}
	}

	/**
	 * XHR helper for the dsh sidecar, chrome-privileged. Uses the shared cookie
	 * jar (the /connect exchange deposits the API cookie there).
	 * @returns {Promise<{status:number, text:string}>}
	 */
	function xhr(url, { method = 'GET', headers = {}, body = null, timeoutMs = 60000, onProgress = null } = {}) {
		return new Promise((resolve, reject) => {
			const req = new XMLHttpRequest({ mozAnon: false });
			req.mozBackgroundRequest = true;
			req.open(method, url, true);
			for (const [name, value] of Object.entries(headers)) req.setRequestHeader(name, value);
			req.timeout = timeoutMs;
			req.onload = () => resolve({ status: req.status, text: req.responseText });
			req.onerror = () => reject(new Error(`网络错误: ${method} ${url}`));
			req.ontimeout = () => reject(new Error(`请求超时: ${method} ${url}`));
			if (onProgress) {
				req.onprogress = (event) => {
					try { onProgress(req.responseText, event.loaded, event.total); } catch (e) { DSH.Util.log('progress handler failed', e); }
				};
			}
			req.send(body);
		});
	}

	return {
		PREF_BRANCH,
		prefGet, prefSet, prefGetJSON, prefSetJSON,
		log, uuid, homeDir, joinPath, pathExists, readTextFile, writeTextFile, pathToURI,
		httpServerPort,
		toast, xhr,
	};
})();
