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
        if (!target || window.__dshInZoteroLastNav === target) {
          if (!target) clearInterval(hashTimer)
          return
        }
        openFromHash()
      }, 1000)

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
