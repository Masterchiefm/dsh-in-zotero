// dsh-in-zotero — end-to-end test hook. NEVER loaded in a normal session:
// bootstrap.js only loads this file when Zotero itself was launched with
// DSH_IN_ZOTERO_E2E=1 in its environment (the e2e harness does that).
//
// It exposes one token-guarded endpoint that evaluates JavaScript inside
// Zotero, so the harness can inspect integration state and drive Zotero's own
// dialogs (citation dialog, document preferences) the way a user would —
// things that cannot be reached from the WPS add-in side.

DSH.E2E = (() => {
	const { log } = DSH.Util;
	const NAME = '/dsh-bridge-e2e/eval';
	const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

	async function evaluate(code) {
		const fn = new AsyncFunction('DSH', 'Zotero', 'Services', code);
		const value = await fn(DSH, Zotero, Services);
		return JSON.stringify({ ok: true, value: value === undefined ? null : value }, (key, v) => {
			if (v && typeof v === 'object' && !(v instanceof Array) && !(v instanceof Date) && typeof v.toJSON !== 'function'
				&& Object.prototype.toString.call(v) !== '[object Object]') {
				return `[${v.constructor?.name || typeof v}]`; // Zotero objects: name only
			}
			if (typeof v === 'bigint') return String(v);
			return v;
		});
	}

	function endpoint() {
		const e = function () {};
		e.prototype = {
			supportedMethods: ['POST'],
			supportedDataTypes: ['application/json'],
			init: async ({ headers, data }) => {
				const provided = headers?.['x-dsh-in-zotero-token'];
				if (!provided || provided !== DSH.Sidecar.bridgeToken()) {
					return [403, 'application/json', JSON.stringify({ ok: false, error: { code: 'zotero/bad-token', message: 'invalid bridge token' } })];
				}
				try {
					return [200, 'application/json', await evaluate(String(data?.code ?? ''))];
				}
				catch (e) {
					return [500, 'application/json', JSON.stringify({ ok: false, error: { code: 'e2e/eval-failed', message: e?.message ?? String(e), stack: String(e?.stack ?? '').slice(0, 2000) } })];
				}
			},
		};
		return e;
	}

	function register() {
		// The Zotero HTTP server may be down because another program squats its
		// port; without it nothing can call in. Bring it up on a free port first.
		const ready = Zotero.Promise.delay(1500).then(async () => {
			for (let i = 0; i < 20 && typeof Zotero.DSHinZotero?.enableHttpServer !== 'function'; i++) {
				await Zotero.Promise.delay(500);
			}
			if (DSH.Util.httpServerPort() == null) await Zotero.DSHinZotero.enableHttpServer();
			if (Zotero.Server.Endpoints && !Zotero.Server.Endpoints[NAME]) Zotero.Server.Endpoints[NAME] = endpoint();
			log(`e2e hook registered on port ${DSH.Util.httpServerPort() ?? 'n/a'}`);
		});
		ready.catch((e) => log('e2e hook failed', e?.message ?? e));
	}

	function unregister() {
		delete Zotero.Server.Endpoints?.[NAME];
	}

	return { register, unregister };
})();
