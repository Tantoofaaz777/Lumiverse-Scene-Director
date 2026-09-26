// No awaitable frontend queue API exists in the inspected host. Observe its
// matching request in this document, without modifying request or response.
export function observeNativeSave(chatId: string, text: string, signal: AbortSignal, dispatch: () => void): Promise<void> {
  if (typeof window.fetch !== 'function') return Promise.reject(new Error('The native save transport is unavailable.'))
  return new Promise((resolve, reject) => {
    const previous = window.fetch
    let settled = false
    let captured = false
    let expectedContent = ''
    let timer: ReturnType<typeof setTimeout>
    const detach = () => { if (window.fetch === observe) window.fetch = previous }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      detach()
      signal.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => finish()
    const uncertain = () => finish(new Error('Could not confirm Simple Send. Check the chat history before retrying. Your text is available in Recover draft.'))
    const matches = (input: RequestInfo | URL, init?: RequestInit) => {
      // Current host client posts a JSON string. Unknown transport shapes fail
      // closed instead of attributing another request or changing host data.
      if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return false
      try {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
        if (!url.pathname.endsWith(`/chats/${encodeURIComponent(chatId)}/messages`)) return false
        const body = JSON.parse(init.body)
        const matching = body.is_user === true && typeof body.content === 'string'
          && (body.content === text.trim() || body.content.startsWith(`${text.trim()}\n\n`))
        if (matching) expectedContent = body.content
        return matching
      } catch { return false }
    }
    const observe: typeof fetch = (input, init) => {
      const selected = !settled && !captured && matches(input, init)
      if (selected) {
        captured = true
        detach()
        clearTimeout(timer)
        timer = setTimeout(uncertain, 35000) // Host HTTP timeout is 30 seconds.
      }
      try {
        const response = previous.call(window, input, init)
        if (selected) void response.then(async result => {
          if (!result.ok) throw new Error(`Simple Send failed (HTTP ${result.status}).`)
          const message = await result.clone().json()
          if (typeof message?.id !== 'string' || message.chat_id !== chatId || message.is_user !== true || message.content !== expectedContent) throw new Error('Unexpected save response.')
          finish()
        }).catch(error => finish(new Error(`${error instanceof Error ? error.message : 'Save connection failed.'} Check history before retrying; your text is available in Recover draft.`)))
        return response
      } catch (error) {
        if (selected) uncertain()
        throw error
      }
    }
    timer = setTimeout(uncertain, 15000)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    window.fetch = observe
    try { dispatch() } catch (error) { finish(error instanceof Error ? error : new Error('Simple Send failed.')) }
  })
}
