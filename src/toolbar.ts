import { GUIDE_ICON, SIMPLE_ICON } from './action-icons'
import { composer } from './composer'

// Like Saucepan's toolbar, this lives directly before InputArea's input row.
// Keep the host DOM dependency here; never move or replace React-owned nodes.
export function mountGuideToolbar(onClick: () => void, onSimpleSend: () => void, state: () => { ready: boolean; busy: boolean; drafts: number; integrated: boolean }, onRecover: () => void, refreshActions: () => void) {
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
  button.innerHTML = GUIDE_ICON
  button.addEventListener('click', onClick)
  const simple = document.createElement('button')
  simple.type = 'button'
  simple.setAttribute('aria-label', 'Simple Send')
  simple.innerHTML = SIMPLE_ICON
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
    refreshActions()
    const { ready, busy, drafts, integrated } = state()
    if (button.hidden !== integrated) button.hidden = integrated
    if (simple.hidden !== integrated) simple.hidden = integrated
    const actionDisplay = integrated ? 'none' : 'inline-flex'
    if (button.style.display !== actionDisplay) button.style.display = actionDisplay
    if (simple.style.display !== actionDisplay) simple.style.display = actionDisplay
    if (integrated && !drafts) { toolbar.remove(); return }
    let current: ReturnType<typeof composer>
    try { current = composer() } catch { toolbar.remove(); return }
    const area = current.input.closest('[data-component="InputArea"]')
    const row = current.input.parentElement?.parentElement
    if (!area || !row || row.parentElement !== area) { toolbar.remove(); return }
    if (toolbar.parentElement !== area || toolbar.nextElementSibling !== row) area.insertBefore(toolbar, row)
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
