// Browser half of dsh-in-zotero-bridge. The dsh web UI runs inside a REMOTE
// (out-of-process) Zotero browser, so the Zotero side cannot touch page
// globals. Control flows through two same-origin channels instead:
//
//   * navigation: the Zotero side loads `<url>#session=<id>`; this plugin
//     watches the hash (initial load + hashchange) and drives the native
//     uiWorkspace.openSession() — a hash-only change does not reload the SPA.
//   * observation: this plugin reports the session-id list to the host half's
//     /api/zotero/rpc route every 2s, which the Zotero side polls (new-session
//     detection for per-article rebinding).
//
// Loaded as a classic script via window.__ModuleLoader__ (the harness's client
// module system); platform services are injected by the shell, so nothing is
// bundled.

window.__ModuleLoader__.load({
  id: 'dsh-in-zotero-bridge',
  factory: (require) => {
    const module = { exports: {} }

    module.exports.name = 'dsh-in-zotero-bridge'
    module.exports.inject = []

    module.exports.apply = function apply(ctx) {
      let openNativeSession
      let sessionsApi

      ctx.effect(() => ctx.inject(['uiWorkspace'], (scoped) => {
        openNativeSession = (sessionId) => scoped.uiWorkspace.openSession(sessionId)
        return () => { openNativeSession = undefined }
      }), 'dsh-in-zotero: uiWorkspace bridge')

      ctx.effect(() => ctx.inject(['sessions'], (scoped) => {
        sessionsApi = scoped.sessions
        return () => { sessionsApi = undefined }
      }), 'dsh-in-zotero: sessions bridge')

      const snapshot = () => {
        try {
          const s = sessionsApi?.list?.getSnapshot?.()
          if (!s) return []
          return (s.ids ?? Object.keys(s.byId ?? {})).map(String)
        }
        catch (error) {
          return []
        }
      }

      // -- hash navigation -----------------------------------------------------
      const openFromHash = () => {
        const match = /(?:^|[#&])session=([A-Za-z0-9-]+)/.exec(window.location.hash || '')
        if (match && openNativeSession) {
          try {
            openNativeSession(match[1])
            window.__dshInZoteroLastNav = match[1]
            console.info('[dsh-in-zotero] openSession via hash:', match[1])
          }
          catch (error) {
            console.warn('[dsh-in-zotero] openSession failed', error)
          }
        }
      }
      window.addEventListener('hashchange', openFromHash)
      ctx.effect(() => () => { window.removeEventListener('hashchange', openFromHash) }, 'dsh-in-zotero: hash nav')
      // The SPA may mount the workspace UI long after we run; keep retrying
      // the pending hash target (up to ~5 min) until one openSession lands.
      const pendingHash = () => /(?:^|[#&])session=([A-Za-z0-9-]+)/.exec(window.location.hash || '')?.[1] ?? null
      const hashTimer = setInterval(() => {
        const target = pendingHash()
        if (!target) clearInterval(hashTimer)
        else if (window.__dshInZoteroLastNav !== target) openFromHash()
        void applyAsk()
      }, 1000)

      // -- ask prefill (「问 AI」 from the Zotero translate popup) ---------------
      // `#session=<id>&ask=<urlencoded>&n=<nonce>` opens the session AND types
      // the text into the composer WITHOUT sending — the user completes the
      // question and presses send themselves. The nonce makes every ask (even
      // a repeated identical one) count as a new instruction.
      let appliedAskNonce = null
      let askInFlight = false

      const parseAsk = () => {
        const hash = window.location.hash || ''
        return {
          session: /(?:^|[#&])session=([A-Za-z0-9-]+)/.exec(hash)?.[1] ?? null,
          ask: /(?:^|[#&])ask=([^&]+)/.exec(hash)?.[1] ?? null,
          nonce: /(?:^|[#&])n=([A-Za-z0-9-]+)/.exec(hash)?.[1] ?? null,
        }
      }

      const findComposer = () => {
        // The dsh composer is a Lexical rich-text editor (contenteditable
        // with data-lexical-editor). Prefer that, then explicit composer
        // hooks, then the bottom-most visible editor on screen.
        const visible = (el) => el.offsetParent !== null || el === document.activeElement
        const lexical = [...document.querySelectorAll('[data-lexical-editor="true"]')].filter(visible)
        if (lexical.length) {
          lexical.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
          return lexical[0]
        }
        const direct = document.querySelector('[data-testid="composer-text"], [class*="composer"] textarea, [class*="composer"] [contenteditable="true"]')
        if (direct && visible(direct)) return direct
        const editors = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
          .filter((el) => visible(el))
        if (!editors.length) return null
        editors.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)
        return editors[0]
      }

      const setComposerText = (el, text) => {
        el.focus()
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          // React-controlled inputs ignore direct value writes; the native
          // setter + bubbling input event is the standard way through.
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (setter) setter.call(el, text)
          else el.value = text
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return
        }
        // Contenteditable (Lexical): drive the BROWSER's input pipeline —
        // Lexical handles beforeinput/input itself and reverts any direct
        // DOM writes through its mutation observer. select-all-then-insert
        // replaces a previous ask; on an empty editor it just inserts.
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        sel.removeAllRanges()
        sel.addRange(range)
        let inserted = false
        try { inserted = document.execCommand('insertText', false, text) } catch { inserted = false }
        if (!inserted) {
          el.textContent = text
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        }
      }

      const applyAsk = async () => {
        if (askInFlight) return
        const { session, ask, nonce } = parseAsk()
        if (!session || !ask || !nonce || nonce === appliedAskNonce) return
        askInFlight = true
        try {
          let text = ask
          try { text = decodeURIComponent(ask) } catch { /* keep raw */ }
          if (openNativeSession) {
            try {
              openNativeSession(session)
              window.__dshInZoteroLastNav = session
            }
            catch (error) {
              console.warn('[dsh-in-zotero] openSession (ask) failed', error)
            }
          }
          // The freshly opened session view mounts asynchronously — poll for
          // its composer before typing (~15 s budget).
          let el = null
          for (let i = 0; i < 30 && !el; i++) {
            el = findComposer()
            if (!el) await new Promise((resolve) => setTimeout(resolve, 500))
          }
          // Fill, then verify on the LIVE composer: the session view may
          // remount mid-fill and replace the editor node, so re-query and
          // re-fill until the content actually sticks (≤3 attempts).
          let ok = false
          let filledLen = null
          let fillEl = el
          if (fillEl) {
            for (let attempt = 0; attempt < 3 && !ok; attempt++) {
              try { setComposerText(fillEl, text) }
              catch (error) {
                console.warn('[dsh-in-zotero] composer fill failed', error)
                break
              }
              await new Promise((resolve) => setTimeout(resolve, 300))
              fillEl = findComposer() ?? fillEl
              const len = (fillEl instanceof HTMLTextAreaElement || fillEl instanceof HTMLInputElement)
                ? fillEl.value.length
                : (fillEl.textContent ?? '').length
              if (len > 0) {
                ok = true
                filledLen = len
              }
            }
          }
          appliedAskNonce = nonce
          window.__dshInZoteroLastAsk = {
            nonce,
            session,
            ok,
            filledLen,
            composer: fillEl ? `${fillEl.tagName.toLowerCase()}${fillEl.getAttribute('data-lexical-editor') ? '/lexical' : ''}${fillEl.className ? `.${String(fillEl.className).split(/\s+/).join('.')}` : ''}` : null,
          }
          console.info('[dsh-in-zotero] ask applied:', nonce, ok ? `typed (${filledLen} chars in composer)` : 'composer not found')
        }
        finally {
          askInFlight = false
        }
      }

      // -- state reporting -----------------------------------------------------
      const report = () => {
        try {
          fetch('/api/zotero/rpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              op: 'ui.report',
              payload: {
                sessionIds: snapshot(),
                lastNav: window.__dshInZoteroLastNav ?? null,
                lastAsk: window.__dshInZoteroLastAsk ?? null,
                href: window.location.href,
              },
            }),
          }).catch(() => { /* offline tab */ })
        }
        catch (error) { /* ignore */ }
      }
      const reportTimer = setInterval(report, 2000)
      report()
      ctx.effect(() => () => { clearInterval(reportTimer); clearInterval(hashTimer) }, 'dsh-in-zotero: report loop')

      // Kept for diagnostics in a normal browser (same-process embeds).
      const bridge = {
        version: '0.4.0',
        getState() {
          return { ready: true, sessionIds: snapshot(), lastNav: window.__dshInZoteroLastNav ?? null }
        },
        openSession(sessionId) {
          if (!openNativeSession) return false
          try {
            openNativeSession(String(sessionId))
            window.__dshInZoteroLastNav = String(sessionId)
            return true
          }
          catch (error) {
            console.warn('[dsh-in-zotero] openSession failed', error)
            return false
          }
        },
      }
      try {
        Object.defineProperty(window, '__dshInZotero', { value: bridge, configurable: true })
      }
      catch (error) {
        window.__dshInZotero = bridge
      }
      console.info('[dsh-in-zotero] client bridge ready (hash-nav + ui.report)')
    }

    return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })
  },
})
