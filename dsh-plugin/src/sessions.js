// Session management for dsh-in-zotero: a dedicated "Zotero" workspace plus
// the create/resolve/list primitives the Zotero plugin's session window and
// the metadata-task dispatcher use. Every task (e.g. a metadata refetch) gets
// its OWN fresh session — there is deliberately no long-lived assistant
// session, so task histories never bleed into each other. Adapted from
// dsh-zot-library's src/host/chat.js.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const STATE_VERSION = 3

/** Upper bound on remembered per-session contexts (LRU by `at`). */
const SESSION_CONTEXT_LIMIT = 50

export function dshHome() {
  return process.env.DSH_HOME
    ? String(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
}

function statePath() {
  return path.join(dshHome(), 'dsh-in-zotero-bridge-state.json')
}

/** Tiny persisted state. The per-session context map is what the system-prompt
 * guidance reads: each Zotero-side session records what the user was looking
 * at when it was current (mode, article id/title/metadata), so every
 * conversation — task sessions included — gets the right guidance. */
export function createInstanceState(logger = console) {
  let state = { version: STATE_VERSION, sessionContext: {} }
  let saveTimer = null
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      // v2 files held a single global chatContext — deliberately dropped:
      // applying the LAST panel context to unrelated sessions (metadata tasks)
      // made the guidance claim the user was reading something else.
      state = {
        ...state,
        sessionContext: parsed.sessionContext && typeof parsed.sessionContext === 'object'
          ? parsed.sessionContext
          : {},
      }
    }
  }
  catch {
    // First run — the default state stands.
  }
  const save = () => {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        fs.mkdirSync(path.dirname(statePath()), { recursive: true })
        fs.writeFileSync(statePath(), JSON.stringify(state, null, 2))
      }
      catch (error) {
        logger.warn?.(`dsh-in-zotero: state save failed: ${error?.message ?? error}`)
      }
    }, 250)
    if (saveTimer.unref) saveTimer.unref()
  }
  return {
    get() {
      return state
    },
    patch(next) {
      state = { ...state, ...next }
      save()
    },
    /** Record/refresh one session's context, pruning the LRU tail. */
    patchSessionContext(sessionId, context) {
      const map = { ...(state.sessionContext ?? {}) }
      map[sessionId] = { ...context, at: Date.now() }
      const keys = Object.keys(map)
      if (keys.length > SESSION_CONTEXT_LIMIT) {
        keys.sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
        for (const key of keys.slice(0, keys.length - SESSION_CONTEXT_LIMIT)) delete map[key]
      }
      state = { ...state, sessionContext: map }
      save()
    },
  }
}

/** Directory of the dedicated Zotero workspace. */
export function workspaceDir() {
  return path.join(dshHome(), 'dsh-in-zotero-workspace')
}

/** Ensure the Zotero workspace exists and return its id. */
export async function ensureWorkspace(ctx) {
  fs.mkdirSync(workspaceDir(), { recursive: true })
  const registry = ctx.workspaceRegistry
  const known = await registry.resolveByPath(workspaceDir())
  if (known) return known.id
  const created = await registry.create(workspaceDir(), 'Zotero')
  return created.id
}

/** The standard preset, when the deployment composes one. */
async function presetName(ctx) {
  const presets = ctx.get?.('agentPresets')
  if (presets === undefined) return undefined
  try {
    const list = await presets.list()
    return list.some(preset => preset.id === 'standard' && preset.broken === undefined) ? 'standard' : undefined
  }
  catch {
    return undefined
  }
}

/** Create a fresh session in the Zotero workspace. */
export async function createSession(ctx, { title } = {}) {
  const workspaceId = await ensureWorkspace(ctx)
  const preset = await presetName(ctx)
  const { sessionId } = await ctx.sessionController.create({
    workspaceId,
    ...(preset === undefined ? {} : { agentPreset: preset }),
  })
  if (title) {
    const resolved = await ctx.sessionController.resolveAgent(sessionId).catch(() => undefined)
    if (resolved && !('error' in resolved)) {
      try {
        await ctx.sessionTitle.rename(resolved.agent.session, String(title).slice(0, 200))
      }
      catch {
        // Cosmetic — a failed rename must not fail the open.
      }
    }
  }
  return sessionId
}

/** Whether the session still exists on the host. */
export async function resolveAlive(ctx, sessionId) {
  if (!sessionId) return false
  try {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    return resolved && !('error' in resolved)
  }
  catch {
    return false
  }
}

/** Send a user message into a session (queued turn). */
export async function sendPrompt(ctx, sessionId, text) {
  await ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, AbortSignal.timeout(30_000))
  return { sessionId }
}

/** List sessions with best-effort titles (Zotero workspace first). Titles
 * live in the summary's projection snapshot under `values.title` (the same
 * data dsh's own UI renders) — NOT `projectionValues`. Each row carries
 * `zotero` (belongs to the Zotero workspace) and `archived` (soft-deleted out
 * of its workspace), so the Zotero side can scope its dropdown and sweeps
 * without guessing by path. */
export async function listSessions(ctx) {
  const result = await ctx.sessionController.list({}, AbortSignal.timeout(30_000))
  const items = Array.isArray(result?.items) ? result.items : []
  const zoteroDir = workspaceDir().replaceAll('\\', '/').toLowerCase()
  const archived = new Set(
    Array.isArray(ctx.workspaceRegistry?.archivedSessionIds)
      ? ctx.workspaceRegistry.archivedSessionIds.map(String)
      : [],
  )
  const rows = items.map((summary) => {
    const values = summary?.projections?.values ?? {}
    const sessionId = String(summary.sessionId)
    return {
      sessionId,
      title: String(values.title ?? summary.title ?? ''),
      running: summary.running === true,
      blank: summary.blank === true,
      cwd: summary.cwd,
      zotero: String(summary.cwd ?? '').replaceAll('\\', '/').toLowerCase() === zoteroDir,
      archived: archived.has(sessionId),
      updatedAt: Number(summary.updatedAt ?? 0),
    }
  })
  rows.sort((a, b) => {
    if (a.zotero !== b.zotero) return a.zotero ? -1 : 1
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
  return rows.slice(0, 100)
}

/** Archive sessions out of their workspace — dsh's own soft-delete, the same
 * call its UI makes (reversible via unarchive, data stays on disk). Used to
 * sweep the blank placeholder sessions list-mode opens would otherwise pile
 * up. One stubborn session must not block the rest. */
export async function archiveSessions(ctx, sessionIds, logger = console) {
  const archived = []
  for (const sessionId of [...new Set((sessionIds ?? []).map(String).filter(Boolean))]) {
    try {
      await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
      archived.push(sessionId)
    }
    catch (error) {
      logger.warn?.(`dsh-in-zotero: archiving session "${sessionId}" failed: ${error?.message ?? error}`)
    }
  }
  return { ok: true, archived, count: archived.length }
}
