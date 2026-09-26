import { composer } from './composer'

// Like Saucepan's toolbar, this lives directly before InputArea's input row.
// Keep the host DOM dependency here; never move or replace React-owned nodes.
export function mountGuideToolbar(onClick: () => void, onSimpleSend: () => void, state: () => { ready: boolean; busy: boolean; drafts: number }, onRecover: () => void) {
  const toolbar = document.createElement('div')
  toolbar.id = 'sd-guide-toolbar'
  const style = document.createElement('style')
  style.textContent = `
    #sd-guide-toolbar {
      display: flex; align-items: center; gap: 4px; padding: 4px 8px;
      flex-shrink: 0; box-sizing: border-box; border-top: 1px solid var(--lumiverse-border);
    }
    #sd-guide-toolbar button {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; padding: 0; border-radius: 5px;
      border: 1px solid transparent; background: transparent;
      color: var(--lumiverse-text-dim); cursor: pointer;
      transition: background .13s, color .13s, border-color .13s;
    }
    #sd-guide-toolbar button:hover:not(:disabled) {
      background: var(--lumiverse-fill); color: var(--lumiverse-text);
    }
    #sd-guide-toolbar button:focus-visible {
      outline: 2px solid var(--lumiverse-accent); outline-offset: 2px;
    }
    #sd-guide-toolbar button:disabled { cursor: default; opacity: .45; }
    #sd-guide-toolbar button[aria-busy="true"] { color: var(--lumiverse-accent); opacity: .75; }
  `
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', 'Guide Response')
  // Inline clapperboard icon, styled with the host theme's current text color.
  button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m4 11 16-4-1-4L3 7l1 4Z"/><path d="m8 6 3 4m3-6 3 4M4 11v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7M4 14h16"/></svg>'
  button.addEventListener('click', onClick)
  const simple = document.createElement('button')
  simple.type = 'button'
  simple.setAttribute('aria-label', 'Simple Send')
  simple.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13"/><path d="M19 2v6m-3-3h6"/></svg>'
  simple.addEventListener('click', onSimpleSend)
  const recovery = document.createElement('button')
  recovery.type = 'button'
  recovery.setAttribute('aria-label', 'Recover draft')
  recovery.title = 'Recover text from an unconfirmed Simple Send'
  recovery.textContent = '↶'
  recovery.addEventListener('click', onRecover)
  toolbar.append(style, button, simple, recovery)
  let disposed = false

  function refresh() {
    if (disposed) return
    let current: ReturnType<typeof composer>
    try { current = composer() } catch { toolbar.remove(); return }
    const area = current.input.closest('[data-component="InputArea"]')
    const row = current.input.parentElement?.parentElement
    if (!area || !row || row.parentElement !== area) { toolbar.remove(); return }
    if (toolbar.parentElement !== area || toolbar.nextElementSibling !== row) area.insertBefore(toolbar, row)
    const { ready, busy, drafts } = state()
    if (recovery.hidden !== !drafts) recovery.hidden = !drafts
    const recoveryDisplay = drafts ? 'inline-flex' : 'none'
    if (recovery.style.display !== recoveryDisplay) recovery.style.display = recoveryDisplay
    if (recovery.disabled !== busy) recovery.disabled = busy
    const disabled = !ready || busy || !current.send || !current.input.value.trim()
    // MutationObserver also sees our own updates. Write only changed values.
    if (button.disabled !== disabled) button.disabled = disabled
    const busyLabel = String(busy)
    if (button.getAttribute('aria-busy') !== busyLabel) button.setAttribute('aria-busy', busyLabel)
    const title = !ready ? 'Scene Direction settings are not ready.'
      : busy ? 'Scene Direction action in progress…'
      : !current.send ? 'Wait for the current generation to finish.'
      : !current.input.value.trim() ? 'Type a scene direction first.' : 'Guide Response'
    if (button.title !== title) button.title = title
    const simpleDisabled = busy || !current.send || !current.input.value.trim()
    if (simple.disabled !== simpleDisabled) simple.disabled = simpleDisabled
    const simpleTitle = busy ? 'Scene Direction action in progress…'
      : !current.send ? 'Wait for the current generation to finish.'
      : !current.input.value.trim() ? 'Type a message first.' : 'Simple Send — save your message without generating a reply'
    if (simple.title !== simpleTitle) simple.title = simpleTitle
  }
  function onInput(event: Event) {
    if (event.target instanceof HTMLTextAreaElement && event.target.name === 'chat-message') refresh()
  }
  const observer = new MutationObserver(refresh)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'aria-label'] })
  document.addEventListener('input', onInput, true)
  refresh()
  return {
    refresh,
    destroy() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      document.removeEventListener('input', onInput, true)
      button.removeEventListener('click', onClick)
      simple.removeEventListener('click', onSimpleSend)
      recovery.removeEventListener('click', onRecover)
      toolbar.remove()
    },
  }
}
