import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { DEFAULT_TEMPLATE, DEFAULT_SETTINGS, normalizeSettings } from './core'
import type { Settings } from './core'
import { composer, readDraft, setDraft, waitForEmptyComposer } from './composer'

export function setup(ctx: SpindleFrontendContext) {
  // This public mount is rendered inside Settings → Extensions and marks the
  // extension as having its own settings in Lumiverse's Extensions panel.
  const root = ctx.ui.mount('settings_extensions')
  const heading = document.createElement('h2'); heading.textContent = 'Scene Direction'
  const templateLabel = document.createElement('label'); templateLabel.textContent = 'Prompt Template'
  const template = document.createElement('textarea'); template.rows = 8; template.style.width = '100%'
  const roleLabel = document.createElement('label'); roleLabel.textContent = 'Injection Role'
  const role = document.createElement('select')
  for (const name of ['system', 'user'] as const) { const option = document.createElement('option'); option.value = name; option.textContent = name === 'system' ? 'System' : 'User'; role.append(option) }
  const clearLabel = document.createElement('label')
  const clear = document.createElement('input'); clear.type = 'checkbox'
  clearLabel.append(clear, document.createTextNode(' Clear Input After Guide'))
  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset Template'
  const status = document.createElement('p'); status.setAttribute('role', 'status')
  root.append(heading, templateLabel, template, roleLabel, role, clearLabel, reset, status)
  let current: Settings = DEFAULT_SETTINGS
  let busy = false
  let requestCounter = 0
  const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  function request(type: string, data: Record<string, unknown> = {}): Promise<any> {
    const requestId = `${Date.now()}-${++requestCounter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('The extension backend did not respond.')) }, 5000)
      waiting.set(requestId, { resolve, reject, timer })
      ctx.sendToBackend({ type, requestId, ...data })
    })
  }
  const unsubscribe = ctx.onBackendMessage(raw => {
    const msg = raw as { type?: string; requestId?: string; message?: string }
    const waiter = msg?.requestId && waiting.get(msg.requestId)
    if (!waiter) return
    clearTimeout(waiter.timer); waiting.delete(msg.requestId!)
    if (msg.type === 'error') waiter.reject(new Error(msg.message || 'Scene Direction failed.'))
    else waiter.resolve(msg)
  })
  function show(value: Settings) { current = value; template.value = value.template; role.value = value.role; clear.checked = value.clearInput }
  function save() {
    const next = normalizeSettings({ template: template.value, role: role.value, clearInput: clear.checked })
    void request('settings:save', { settings: next }).then(() => { current = next; status.textContent = 'Saved.' }).catch(error => { status.textContent = error.message })
  }
  template.addEventListener('change', save); role.addEventListener('change', save); clear.addEventListener('change', save)
  reset.addEventListener('click', () => { template.value = DEFAULT_TEMPLATE; save() })
  void request('settings:get').then(result => show(normalizeSettings(result.settings))).catch(error => { status.textContent = error.message })

  const action = ctx.ui.registerInputBarAction({ id: 'guide-response', label: 'Guide Response' })
  const offClick = action.onClick(() => { void guide() })
  async function guide() {
    if (busy) return
    busy = true
    let token: string | undefined
    let chatId: string | undefined
    let original: string | undefined
    let clicked = false
    try {
      chatId = ctx.getActiveChat().chatId ?? undefined
      if (!chatId) throw new Error('Open a chat before guiding a response.')
      const { send } = composer()
      if (!send) throw new Error('The native fresh-reply button is unavailable. Wait for the current generation to finish.')
      original = readDraft()
      if (!original.trim()) throw new Error('Enter a scene direction first.')
      if (!current.template.trim()) throw new Error('Prompt Template cannot be empty.')
      // Always empty the host draft for the send. The preference controls whether
      // it is restored after the native generation has started.
      setDraft('')
      const nativeSend = await waitForEmptyComposer()
      if (ctx.getActiveChat().chatId !== chatId) throw new Error('The active chat changed.')
      token = crypto.randomUUID()
      await request('guide:arm', { chatId, token, input: original })
      if (ctx.getActiveChat().chatId !== chatId || readDraft() !== '') throw new Error('The chat draft changed before generation started.')
      nativeSend.click()
      clicked = true
      // If the host rejected the click, the short backend expiry still disarms it.
      // Restoration is deferred so React handleSend reads the empty draft.
      if (!current.clearInput) setTimeout(() => { if (ctx.getActiveChat().chatId === chatId && readDraft() === '') setDraft(original!) }, 1000)
    } catch (error) {
      if (token && chatId) void request('guide:cancel', { chatId, token }).catch(() => {})
      if (!clicked && original !== undefined && ctx.getActiveChat().chatId === chatId && readDraft() === '') setDraft(original)
      status.textContent = error instanceof Error ? error.message : 'Guide Response failed.'
      window.alert(status.textContent)
    } finally { if (clicked) setTimeout(() => { busy = false }, 2000); else busy = false }
  }
  return () => {
    offClick(); action.destroy(); root.replaceChildren(); unsubscribe()
    for (const waiter of waiting.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Extension unloaded.')) }
    waiting.clear()
  }
}
