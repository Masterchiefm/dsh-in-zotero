// One-shot translation over dsh's own llm service: no session, no transcript.
// Streamed to Zotero's reader selection popup as NDJSON. Adapted from
// dsh-zot-library's src/host/translate.js; the model route follows dsh's
// current selection, thinking follows the plugin's translateThinking pref
// (passed in the request body by the Zotero side).

const MAX_INPUT_CHARS = 24_000
const MAX_TOKENS_PLAIN = 4096
const MAX_TOKENS_THINKING = 8192

const SYSTEM_PROMPT = [
  '你是学术论文翻译助手。用户会给你一段从文献中选中的文字。',
  '若原文以外文（英/日/德/法等）为主，翻译成简体中文；若原文以中文为主，翻译成英文。',
  '要求：准确、通顺、符合学术语境；专业术语首次出现时可在括号内保留原文或缩写；',
  '人名、地名、机构名保留原文。只输出译文本身，不要任何解释、前言或引号。',
].join('')

function userMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-in-zotero-translate' },
  }
}

/** Human-readable label for a route; falls back to the 'provider/model' id
 * when the registry can't name it. */
async function routeLabel(llm, route) {
  const id = `${route.provider}/${route.model}`
  try {
    const rows = await llm.listModels(route.provider)
    const hit = (rows ?? []).find(m => m?.id === route.model)
    if (hit?.name) return { id, name: String(hit.name) }
  }
  catch { /* registry unavailable — the id is still truthful */ }
  return { id, name: id }
}

function resolveRoute(extensions, explicitModel = '') {
  // An explicit 'provider/model' (translate-model picker) wins over dsh's
  // current selection. Both ids are registry ids without embedded slashes.
  const want = String(explicitModel ?? '').trim()
  if (want) {
    const slash = want.indexOf('/')
    if (slash > 0 && slash < want.length - 1) {
      return { provider: want.slice(0, slash), model: want.slice(slash + 1) }
    }
  }
  const current = extensions.agentDefaultModel?.currentSelection?.()
  if (current?.provider && current?.model) {
    return { provider: String(current.provider), model: String(current.model) }
  }
  throw Object.assign(
    new Error('没有可用模型：dsh 尚未配置默认模型。请先在 dsh 网页界面选择模型。'),
    { code: 'zotero/no-model' }
  )
}

/**
 * Build the prepareCall configure callback. `state` captures what was
 * actually applied (the callback is the only place the adapter's model
 * metadata — including its own effort vocabulary — is visible).
 *
 * The effort id for "off" is NOT uniform across adapters: dsh-llm-deepseek
 * says 'off', declared catalog menus say 'disabled', and budget-ladder
 * models (our-free-model) have no off at all — thinking shares their output
 * ceiling and can only be shrunk. Leaving the control unset when 'off' is
 * absent made dsh fall back to the model's defaultEffort (usually high):
 * thinking streamed despite the toggle being off, per selected model.
 */
function configureControls(thinking, state) {
  return (controls, model) => {
    const efforts = model?.reasoning?.efforts ?? []
    if (efforts.length === 0) return controls
    const ids = efforts.map(effort => effort.id)
    if (thinking) {
      const pick = ids.includes('high') ? 'high' : ids[ids.length - 1]
      state.effort = pick
      return { ...controls, reasoningEffort: pick }
    }
    const offish = ids.find(id => id === 'off' || id === 'disabled' || id === 'none')
    const pick = offish ?? ids[0] // lowest declared rung ≈ closest to off
    state.effort = pick
    state.offAvailable = offish !== undefined
    return { ...controls, reasoningEffort: pick }
  }
}

/**
 * The translation service.
 * @param {object} options
 * @param {object} options.extensions - lazily-filled service bridges (llm, agentDefaultModel).
 * @param {object} options.logger
 */
export function createTranslator({ extensions, logger }) {
  /** All configured models (diagnostics). */
  async function listModels() {
    const llm = extensions.llm
    let current = null
    try {
      const selection = extensions.agentDefaultModel?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        current = { provider: String(selection.provider), model: String(selection.model) }
      }
    }
    catch {
      current = null
    }
    if (!llm || typeof llm.listProviders !== 'function') return { models: [], current }
    const models = []
    try {
      for (const provider of llm.listProviders() ?? []) {
        const rows = await llm.listModels(provider.id).catch(() => [])
        for (const model of rows ?? []) {
          models.push({ id: `${provider.id}/${model.id}`, name: `${model.name}` })
        }
      }
    }
    catch (error) {
      logger.warn?.(`dsh-in-zotero: listing models failed: ${error?.message ?? error}`)
    }
    return { models, current }
  }

  /**
   * Run one translation; returns an NDJSON Response of
   * {type:'meta'|'thinking'|'answer'|'done'|'error'} lines — meta (the
   * resolved model, {model:name, id:'provider/model'}, plus what was applied
   * for thinking: {thinkingRequested, thinkingEffort, thinkingForced}) is the
   * first line, sent before the first chunk.
   * opts.model: explicit 'provider/model' from the translate-model picker;
   * empty = dsh's current selection.
   */
  function stream(text, signal, { thinking = false, model = '' } = {}) {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim()
    const fail = (error) => new Response(JSON.stringify({
      error: { code: error?.code ?? 'zotero/translate', message: String(error?.message ?? error) },
    }), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } })
    if (body === '') return fail(Object.assign(new Error('没有可翻译的文字'), { code: 'zotero/invalid' }))
    if (body.length > MAX_INPUT_CHARS) {
      return fail(Object.assign(
        new Error(`选中文本过长（${body.length} 字符），请缩小选择范围（上限 ${MAX_INPUT_CHARS}）`),
        { code: 'zotero/invalid' }
      ))
    }
    const llm = extensions.llm
    if (!llm || typeof llm.prepareCall !== 'function') {
      return fail(Object.assign(new Error('当前 dsh 宿主没有可用的模型服务，无法翻译'), { code: 'zotero/no-llm' }))
    }
    let route
    try {
      route = resolveRoute(extensions, model)
    }
    catch (error) {
      return fail(error)
    }

    const abort = new AbortController()
    const onAbort = () => abort.abort(new Error('client cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const encoder = new TextEncoder()
    const readStream = new ReadableStream({
      async start(controller) {
        const send = (event) => {
          try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) } catch { /* closed */ }
        }
        try {
          // The configure callback is the only place the adapter's model
          // metadata (its own effort vocabulary) is visible — capture what
          // was applied, then report it in meta before the first chunk.
          const applied = { effort: null, offAvailable: false }
          const call = await llm.prepareCall(
            { provider: route.provider, model: route.model, maxTokens: thinking ? MAX_TOKENS_THINKING : MAX_TOKENS_PLAIN },
            abort.signal,
            configureControls(thinking, applied)
          )
          send({
            type: 'meta',
            ...(await routeLabel(llm, route)),
            thinkingRequested: thinking,
            thinkingEffort: applied.effort,
            // Toggle was off but the model has no off level — the lowest
            // rung was forced instead (it may still think a little).
            thinkingForced: !thinking && applied.effort !== null && !applied.offAvailable,
          })
          const options = {
            ...call.config,
            messages: [userMessage(body)],
            system: SYSTEM_PROMPT,
            signal: abort.signal,
          }
          for await (const chunk of call.stream(options)) {
            if (chunk.type === 'reasoning-delta') send({ type: 'thinking', text: chunk.text })
            else if (chunk.type === 'text-delta') send({ type: 'answer', text: chunk.text })
            else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
              throw new Error(chunk.reason?.failure?.message ?? '模型调用失败')
            }
          }
          send({ type: 'done' })
        }
        catch (error) {
          if (!abort.signal.aborted) send({ type: 'error', message: String(error?.message ?? error) })
        }
        finally {
          signal?.removeEventListener('abort', onAbort)
          try { controller.close() } catch { /* closed */ }
        }
      },
      cancel() {
        abort.abort(new Error('client cancelled'))
        signal?.removeEventListener('abort', onAbort)
      },
    })
    return new Response(readStream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  return { listModels, stream }
}
