// Host half of dsh-in-zotero: registers the zotero_* agent tools, the
// /api/zotero routes the Zotero plugin calls (session ops, metadata tasks,
// streaming translation), and the system-prompt guidance for Zotero sessions.
//
// The browser half (client.js) is declared through package.json's dsh.client
// and exposes session-driving globals inside the dsh web UI (which the Zotero
// session window embeds).

import { fileURLToPath } from 'node:url'
import { createTools } from './src/tools.js'
import { createTranslator } from './src/translate.js'
import { version } from './src/version.js'
import {
  createInstanceState, createSession, resolveAlive,
  listSessions, archiveSessions, sendPrompt, workspaceDir,
} from './src/sessions.js'
import { zoteroGuidance, refetchTaskMessage, wishTaskMessage } from './src/prompts.js'

export const name = 'dsh-in-zotero-bridge'
export { version }

// 'tools' is the engine's ToolRegistry service (the same dependency the
// engine's own dsh-tool-cordis plugin declares). Declaring it here means the
// bundle only activates once the registry exists and ctx.tools is wired.
export const inject = ['connection', 'sessionController', 'sessionTitle', 'workspaceRegistry', 'tools']

/**
 * @param {object} ctx - cordis context.
 * @param {object} [config] - bundle config.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const packageDir = fileURLToPath(new URL('./', import.meta.url))
  logger.info?.(`dsh-in-zotero bridge ${version} loaded`)

  // Optional service bridges: translation needs dsh's llm runtime and the
  // current model selection, but everything else works without them.
  const extensions = {}
  ctx.effect(() => ctx.inject(['llm'], (scoped) => {
    extensions.llm = scoped.llm
    return () => { extensions.llm = undefined }
  }), 'dsh-in-zotero: llm bridge')
  ctx.effect(() => ctx.inject(['agentDefaultModel'], (scoped) => {
    extensions.agentDefaultModel = scoped.agentDefaultModel
    return () => { extensions.agentDefaultModel = undefined }
  }), 'dsh-in-zotero: default model bridge')

  const state = createInstanceState(logger)
  const translator = createTranslator({ extensions, logger })

  // --- agent tools ------------------------------------------------------------
  // Registered directly on the injected ToolRegistry. A previous attempt used
  // a runtime `ctx.inject(['tools'], …)` sub-plugin; that waits for a service
  // GROUP the engine never provides, so the callback stayed pending forever
  // and no zotero_* tool ever reached the agent (guidance and /api routes
  // don't depend on it — which is why only the tools silently went missing).
  if (typeof ctx.tools?.register === 'function') {
    const definitions = createTools({ logger })
    const disposers = []
    const failed = []
    for (const definition of definitions) {
      try {
        disposers.push(ctx.tools.register(definition))
      }
      catch (error) {
        failed.push(`${definition?.name}: ${error?.message ?? error}`)
      }
    }
    logger.info?.(`dsh-in-zotero: registered ${disposers.length}/${definitions.length} zotero_* tools${failed.length ? `; FAILED: ${failed.join('; ')}` : ''}`)
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already gone */ }
      }
    }, 'dsh-in-zotero: agent tools')
  }
  else {
    logger.warn?.('dsh-in-zotero: ctx.tools unavailable; zotero_* tools will NOT be visible to agents')
  }

  // --- system-prompt guidance (Zotero sessions only) ---------------------------
  const systemPrompt = ctx.get?.('systemPrompt') ?? ctx.systemPrompt
  if (typeof systemPrompt?.section === 'function') {
    const zoteroDir = workspaceDir()
    const samePath = (a, b) => String(a ?? '').replaceAll('/', '\\').toLowerCase()
      === String(b ?? '').replaceAll('/', '\\').toLowerCase()
    const disposer = systemPrompt.section({
      name: 'dsh-in-zotero:guidance',
      order: 4800,
      text: (assembly) => {
        const agent = assembly?.agent
        const session = agent?.session
        const cwd = session?.cwd ?? session?.header?.cwd ?? session?.meta?.cwd
        if (!samePath(cwd, zoteroDir)) return ''
        // Per-session context: what the user was looking at when THIS session
        // was current on the Zotero side. Sessions without a record (metadata
        // task sessions) get the generic guidance — never another session's
        // "user is reading 《X》" line.
        const sessionId = String(session?.id ?? session?.header?.id ?? '')
        const stored = sessionId ? state.get().sessionContext?.[sessionId] : undefined
        return zoteroGuidance(stored ?? null)
      },
    })
    ctx.effect(() => disposer, 'dsh-in-zotero: guidance section')
  }
  else {
    logger.warn?.('dsh-in-zotero: systemPrompt.section unavailable; guidance will not be injected')
  }

  // --- the /api/zotero/rpc route (called by the Zotero plugin over the sidecar,
  //     authenticated with the web session cookie minted from the launch token)
  const handlers = {
    'status': async () => ({ ok: true, version }),
    'session.create': async (payload) => {
      const sessionId = await createSession(ctx, { title: payload?.title })
      return { ok: true, sessionId }
    },
    'session.resolve': async (payload) => {
      const alive = await resolveAlive(ctx, String(payload?.sessionId ?? ''))
      return { ok: true, alive }
    },
    'session.list': async () => {
      const items = await listSessions(ctx)
      return { ok: true, items }
    },
    // Soft-archive (dsh's own registry call, reversible from its UI) — the
    // Zotero side sweeps blank placeholder sessions through here.
    'session.archive': async (payload) => {
      const ids = Array.isArray(payload?.sessionIds) ? payload.sessionIds : []
      return archiveSessions(ctx, ids, logger)
    },
    // Every refetch task gets its OWN fresh session (one per item), so task
    // histories never bleed into each other and each agent run starts from a
    // clean, self-contained playbook message.
    'task.refetch': async (payload) => {
      const items = (Array.isArray(payload?.items) ? payload.items : [])
        .filter(item => item && Number.isInteger(item.id))
      if (items.length === 0) throw Object.assign(new Error('没有要处理的条目'), { code: 'zotero/invalid' })
      const results = []
      for (const item of items) {
        const title = `元数据重取 · ${String(item.title || `条目 ${item.id}`).slice(0, 80)}`
        const sessionId = await createSession(ctx, { title })
        await sendPrompt(ctx, sessionId, refetchTaskMessage(item))
        results.push({ id: item.id, sessionId, title })
      }
      return {
        ok: true,
        count: results.length,
        items: results,
        // Compat: the first task's session, for callers that surface one.
        sessionId: results[0].sessionId,
        title: results[0].title,
      }
    },
		// The settings pane's 「新功能许愿 / bug 修复」 button: ONE fresh
		// interactive session pre-loaded with a briefing that carries this
		// plugin's own repo URL — the agent's first reply is the question
		// "what do you want?", not a guessed implementation.
		'task.wish': async () => {
			const title = '功能许愿 · dsh-in-zotero'
			const sessionId = await createSession(ctx, { title })
			await sendPrompt(ctx, sessionId, wishTaskMessage())
			return { ok: true, sessionId, title }
		},
		'chat.context': async (payload) => {
			// The Zotero session window pushes this whenever the current session
			// changes (open, new session, tab following, collection tree moves).
			// Keyed by session id so the guidance of each conversation reflects
			// what the user was looking at while THAT conversation was current.
			const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null
			if (!sessionId) return { ok: true }
			const meta = payload?.itemMeta && typeof payload.itemMeta === 'object' ? payload.itemMeta : {}
			// Where the collection tree points (the category the user is
			// browsing): type + id + display path. Task relevance to it is the
			// agent's call — the guidance says so explicitly.
			const rawCollection = payload?.collection && typeof payload.collection === 'object' ? payload.collection : undefined
			const collection = rawCollection
				? {
						type: typeof rawCollection.type === 'string' ? rawCollection.type : undefined,
						id: Number.isInteger(rawCollection.id) ? rawCollection.id : undefined,
						name: typeof rawCollection.name === 'string' ? rawCollection.name.slice(0, 200) : undefined,
						path: typeof rawCollection.path === 'string' ? rawCollection.path.slice(0, 200) : undefined,
					}
				: undefined
			state.patchSessionContext(sessionId, {
				mode: ['list', 'item', 'reader'].includes(payload?.mode) ? payload.mode : 'list',
				itemID: Number.isInteger(payload?.itemID) ? payload.itemID : undefined,
				attachmentID: Number.isInteger(payload?.attachmentID) ? payload.attachmentID : undefined,
				itemKey: typeof payload?.itemKey === 'string' ? payload.itemKey : undefined,
				itemTitle: typeof payload?.itemTitle === 'string' ? payload.itemTitle : undefined,
				itemType: typeof meta.itemType === 'string' ? meta.itemType : undefined,
				creators: Array.isArray(meta.creators) ? meta.creators.map(String).slice(0, 10) : undefined,
				date: typeof meta.date === 'string' ? meta.date : undefined,
				DOI: typeof meta.DOI === 'string' ? meta.DOI : undefined,
				abstract: typeof meta.abstract === 'string' ? meta.abstract : undefined,
				collection,
			})
			return { ok: true }
		},
	}

	// --- embedded-UI state reporting (posted by the client half every 2s;
	//     polled by the Zotero side for new-session detection) -------------------
	let uiState = { sessionIds: [], lastNav: null, lastAsk: null, at: 0 }
	handlers['ui.report'] = async (payload) => {
		uiState = {
			sessionIds: Array.isArray(payload?.sessionIds) ? payload.sessionIds.map(String) : [],
			lastNav: typeof payload?.lastNav === 'string' ? payload.lastNav : null,
			// 「问 AI」composer prefill receipt: nonce + whether the text was
			// actually typed into the composer (Zotero side matches the nonce
			// it put into the ask hash).
			lastAsk: payload?.lastAsk && typeof payload.lastAsk === 'object'
				? {
						nonce: typeof payload.lastAsk.nonce === 'string' ? payload.lastAsk.nonce : null,
						session: typeof payload.lastAsk.session === 'string' ? payload.lastAsk.session : null,
						ok: payload.lastAsk.ok === true,
						filledLen: Number.isInteger(payload.lastAsk.filledLen) ? payload.lastAsk.filledLen : null,
						composer: typeof payload.lastAsk.composer === 'string' ? payload.lastAsk.composer.slice(0, 200) : null,
					}
				: null,
			at: Date.now(),
		}
		return { ok: true }
	}
	handlers['ui.state'] = async () => ({ ok: true, ...uiState })

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/zotero/rpc',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      }
      catch {
        body = {}
      }
      const op = String(body?.op ?? '')
      const handler = handlers[op]
      try {
        if (!handler) throw Object.assign(new Error(`未知操作: ${op}`), { code: 'zotero/unknown-op' })
        const result = await handler(body?.payload ?? {}, request.signal)
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      catch (error) {
        return new Response(JSON.stringify({
          ok: false,
          error: { code: error?.code ?? 'zotero/error', message: String(error?.message ?? error) },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
    },
  }), 'dsh-in-zotero: rpc route')

  // --- streaming translation (NDJSON, same protocol as dsh-zot-library) --------
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/zotero/translate',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let text = ''
      let thinking = false
      let model = ''
      try {
        const body = await request.json()
        text = body?.text
        thinking = body?.thinking === true
        model = String(body?.model ?? '').trim()
      }
      catch {
        text = ''
      }
      return translator.stream(text, request.signal, { thinking, model })
    },
  }), 'dsh-in-zotero: translate route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/zotero/models',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => new Response(JSON.stringify(await translator.listModels()), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  }), 'dsh-in-zotero: models route')
}
