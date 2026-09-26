import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export type SuiteStatus = 'checking' | 'missing' | 'disabled' | 'active' | 'unavailable'

// No public Spindle state selector exposes installed extensions. Use the same
// authenticated, read-only endpoint as the host Extensions panel.
export function watchSuite(ctx: SpindleFrontendContext, changed: (status: SuiteStatus) => void) {
  let disposed = false
  let pending = false
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let status: SuiteStatus = 'checking'
  function publish(next: SuiteStatus) {
    if (disposed || next === status) return
    status = next
    changed(next)
  }
  async function refresh() {
    if (disposed) return
    if (controller) { pending = true; return }
    clearTimeout(timer)
    const request = new AbortController()
    controller = request
    const timeout = setTimeout(() => request.abort(), 5000)
    try {
      const response = await window.fetch('/api/v1/spindle', {
        credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: request.signal,
      })
      if (!response.ok) throw new Error('Extension list unavailable')
      const data: unknown = await response.json()
      const extensions = (data as { extensions?: unknown } | null)?.extensions
      if (!Array.isArray(extensions)) throw new Error('Invalid extension list')
      const suite = extensions.find(item => item?.identifier === 'lumiverse_suite')
      if (!pending) publish(!suite ? 'missing' : suite.enabled === true && suite.has_frontend === true ? 'active' : 'disabled')
    } catch {
      if (!pending) publish('unavailable')
    } finally {
      clearTimeout(timeout)
      controller = undefined
      if (!disposed) {
        const delay = pending ? 0 : 30000
        pending = false
        timer = setTimeout(() => { void refresh() }, delay)
      }
    }
  }
  const onReturn = () => { void refresh() }
  const onVisible = () => { if (document.visibilityState === 'visible') onReturn() }
  const unsubscribers = ['SPINDLE_EXTENSION_LOADED', 'SPINDLE_EXTENSION_UNLOADED', 'SPINDLE_EXTENSION_STATUS', 'SPINDLE_EXTENSION_ERROR', 'SPINDLE_BATCH_CHANGED']
    .map(event => ctx.events.on(event, onReturn))
  window.addEventListener('online', onReturn)
  window.addEventListener('focus', onReturn)
  document.addEventListener('visibilitychange', onVisible)
  void refresh()
  return () => {
    disposed = true
    clearTimeout(timer)
    controller?.abort()
    for (const unsubscribe of unsubscribers) unsubscribe()
    window.removeEventListener('online', onReturn)
    window.removeEventListener('focus', onReturn)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
