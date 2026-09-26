import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { DEFAULT_TEMPLATE, DEFAULT_SETTINGS, normalizeSettings } from './core'
import type { Settings } from './core'
import { composer, readDraft, setDraft, waitForEmptyComposer, freshReplyButton } from './composer'
import { mountGuideToolbar } from './toolbar'
import { simpleSend } from './simple-send'

export function setup(ctx: SpindleFrontendContext) {
  // This public mount is rendered inside Settings → Extensions and marks the
  // extension as having its own settings in Lumiverse's Extensions panel.
  const root = ctx.ui.mount('settings_extensions')
  const style = document.createElement("style");
  style.textContent = `
    .sd-settings { color: var(--lumiverse-text); font: inherit; }
    .sd-title { margin: 0 0 4px; font-size: 16px; font-weight: 650; }
    .sd-intro, .sd-hint { color: var(--lumiverse-text-dim); font-size: 13px; line-height: 1.45; }
    .sd-intro { margin: 0 0 16px; }
    .sd-row { display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 14px 0; border-top: 1px solid var(--lumiverse-border); }
    .sd-row--stack { display: block; }
    .sd-label { display: block; font-size: 14px; font-weight: 550; }
    .sd-hint { margin: 4px 0 0; }
    .sd-control { min-width: 130px; flex: 0 0 auto; }
    .sd-template { margin-top: 12px; width: 100%; min-width: 0; }
    .sd-template textarea { box-sizing: border-box; width: 100%; max-width: 100%; }
    .sd-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--lumiverse-border); }
    .sd-reset { appearance: none; padding: 7px 12px; border-radius: 8px;
      border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill-subtle);
      color: var(--lumiverse-text); font: inherit; font-size: 13px; cursor: pointer; }
    .sd-reset:hover { background: var(--lumiverse-fill-hover); border-color: var(--lumiverse-border-hover); }
    .sd-reset:focus-visible { outline: 2px solid var(--lumiverse-accent); outline-offset: 2px; }
    .sd-status { margin: 0; color: var(--lumiverse-text-dim); font-size: 12px; }
    @media (max-width: 520px) { .sd-row { gap: 10px; } .sd-control { min-width: 108px; } }
  `;
  const panel = document.createElement("section");
  panel.className = "sd-settings";
  const heading = document.createElement("h2");
  heading.className = "sd-title";
  heading.textContent = "Scene Direction";
  const intro = document.createElement("p");
  intro.className = "sd-intro";
  intro.textContent = "Add a temporary direction after the last chat turn for the next reply.";
  function label(title: string, hint: string) {
    const wrap = document.createElement("div");
    const name = document.createElement("span");
    name.className = "sd-label";
    name.textContent = title;
    const description = document.createElement("p");
    description.className = "sd-hint";
    description.textContent = hint;
    wrap.append(name, description);
    return wrap;
  }
  const templateRow = document.createElement("div");
  templateRow.className = "sd-row sd-row--stack";
  const templateSlot = document.createElement("div");
  templateSlot.className = "sd-template";
  templateRow.append(label("Prompt Template", "Use {{input}} to place the draft in the one-shot instruction."), templateSlot);
  const roleRow = document.createElement("div");
  roleRow.className = "sd-row";
  const roleSlot = document.createElement("div");
  roleSlot.className = "sd-control";
  roleRow.append(label("Injection Role", "User by default. Placed after the last chat turn, before post-history instructions."), roleSlot);
  const clearRow = document.createElement("div");
  clearRow.className = "sd-row";
  const clearSlot = document.createElement("div");
  clearSlot.className = "sd-control";
  clearRow.append(label("Clear Input After Guide", "Remove the direction from the chat draft after use."), clearSlot);
  const actions = document.createElement("div");
  actions.className = "sd-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "sd-reset";
  reset.textContent = "Reset Template";
  const status = document.createElement("p");
  status.className = "sd-status";
  status.setAttribute("role", "status");
  actions.append(reset, status);
  panel.append(heading, intro, templateRow, roleRow, clearRow, actions);
  root.append(style, panel);
  const template = ctx.components.mountTextArea(templateSlot, { value: DEFAULT_TEMPLATE, rows: 6, ariaLabel: "Prompt Template", disabled: true, onChange: () => scheduleSave() });
  const role = ctx.components.mountSelect(roleSlot, {
    value: DEFAULT_SETTINGS.role,
    options: [{ value: "user", label: "User" }, { value: "system", label: "System" }],
    ariaLabel: "Injection Role",
    disabled: true, onChange: () => scheduleSave()
  });
  const clear = ctx.components.mountSwitch(clearSlot, { checked: true, ariaLabel: "Clear Input After Guide", disabled: true, onChange: () => scheduleSave() });
  let current: Settings = DEFAULT_SETTINGS
  let disposed = false
  let busy = false
  let simpleController: AbortController | undefined
  let settingsReady = false
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveTail: Promise<void> = Promise.resolve()
  type Reply = { type?: string; requestId?: string; message?: string; settings?: unknown; token?: string; chatId?: string }
  type ActiveGuide = { token: string; chatId: string; original: string; input: HTMLTextAreaElement; clearInput: boolean; started: boolean; watchdog?: ReturnType<typeof setTimeout> }
  let active: ActiveGuide | undefined
  const waiting = new Map<string, { resolve: (value: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  function request(type: string, data: Record<string, unknown> = {}): Promise<Reply> {
    if (disposed) return Promise.reject(new Error('Extension unloaded.'))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('The extension backend did not respond.')) }, 5000)
      waiting.set(requestId, { resolve, reject, timer })
      try { ctx.sendToBackend({ type, requestId, ...data }) }
      catch (error) { clearTimeout(timer); waiting.delete(requestId); reject(error) }
    })
  }
  function restore(guide: ActiveGuide) {
    if (disposed) return
    try {
      if (ctx.getActiveChat().chatId === guide.chatId && composer().input === guide.input && readDraft() === '') setDraft(guide.original)
    } catch { /* The composer may have unmounted during navigation. */ }
  }
  function release(guide: ActiveGuide) {
    clearTimeout(guide.watchdog)
    if (active === guide) { active = undefined; busy = false }
    toolbar.refresh()
  }
  function fail(message: string) {
    status.textContent = message
    window.alert(message)
  }
  const unsubscribe = ctx.onBackendMessage(raw => {
    const msg = raw as Reply
    if (!msg) return
    if (active && msg.token === active.token && msg.chatId === active.chatId) {
      const guide = active
      if (msg.type === 'guide:started') {
        guide.started = true
        clearTimeout(guide.watchdog)
        status.textContent = 'Preparing the guided response…'
        if (!guide.clearInput) restore(guide)
      } else if (msg.type === 'guide:consumed') {
        guide.started = true
        clearTimeout(guide.watchdog)
        if (!guide.clearInput) restore(guide)
        status.textContent = 'Scene direction applied.'
      } else if (msg.type === 'guide:failed') {
        restore(guide); release(guide)
        fail(msg.message || 'The scene direction was not applied.')
      } else if (msg.type === 'guide:finished') {
        status.textContent = 'Guided response completed.'
        release(guide)
      }
    }
    const waiter = msg.requestId && waiting.get(msg.requestId)
    if (!waiter) return
    clearTimeout(waiter.timer); waiting.delete(msg.requestId!)
    if (msg.type === 'error') waiter.reject(new Error(msg.message || 'Scene Direction failed.'))
    else waiter.resolve(msg)
  })
  function snapshot() {
    return normalizeSettings({ version: 2, template: template.getValue(), role: role.getValue(), clearInput: clear.getValue() })
  }
  function show(value: Settings) {
    current = value
    template.update({ value: value.template })
    role.update({ value: value.role })
    clear.update({ checked: value.clearInput })
  }
  function persist(override?: Settings): Promise<void> {
    clearTimeout(saveTimer); saveTimer = undefined
    const next = override ?? snapshot()
    status.textContent = 'Saving…'
    saveTail = saveTail.catch(() => {}).then(async () => {
      await request('settings:save', { settings: next })
      current = next
      if (!disposed) status.textContent = 'Saved.'
    }).catch(error => {
      if (!disposed) status.textContent = error.message
      throw error
    })
    return saveTail
  }
  function scheduleSave() {
    clearTimeout(saveTimer)
    status.textContent = 'Unsaved changes'
    saveTimer = setTimeout(() => { void persist().catch(() => {}) }, 500)
  }
  reset.disabled = true
  reset.addEventListener('click', () => {
    const next = { ...snapshot(), template: DEFAULT_TEMPLATE }
    template.update({ value: DEFAULT_TEMPLATE })
    void persist(next).catch(() => {})
  })
  const ready = request('settings:get').then(result => {
    if (disposed) return
    show(normalizeSettings(result.settings))
    template.update({ disabled: false }); role.update({ disabled: false }); clear.update({ disabled: false })
    reset.disabled = false
    settingsReady = true
    toolbar.refresh()
  })
  void ready.catch(error => { if (!disposed) status.textContent = error.message })

  const toolbar = mountGuideToolbar(() => { void guide() }, () => { void sendOnly() }, () => ({ ready: settingsReady, busy }))
  async function sendOnly() {
    if (busy || disposed) return
    busy = true
    const controller = new AbortController()
    simpleController = controller
    toolbar.refresh()
    try {
      status.textContent = 'Sending your message…'
      await simpleSend(ctx, controller.signal)
      if (!disposed) status.textContent = 'User message saved.'
    } catch (error) {
      if (!disposed) fail(error instanceof Error ? error.message : 'Simple Send failed.')
    } finally {
      simpleController = undefined
      busy = false
      toolbar.refresh()
    }
  }
  async function guide() {
    if (busy || disposed) return
    busy = true
    toolbar.refresh()
    let attempt: ActiveGuide | undefined
    try {
      const chatId = ctx.getActiveChat().chatId
      if (!chatId) throw new Error('Open a chat before guiding a response.')
      await ready
      if (saveTimer) await persist()
      else await saveTail
      if (disposed || ctx.getActiveChat().chatId !== chatId) throw new Error('The active chat changed.')
      const { input, send } = composer()
      if (!send) throw new Error('The native fresh-reply button is unavailable. Wait for the current generation to finish.')
      const original = input.value
      if (!original.trim()) throw new Error('Enter a scene direction first.')
      if (!current.template.trim()) throw new Error('Prompt Template cannot be empty.')
      const draftLabel = send.getAttribute('aria-label') || ''
      attempt = { token: crypto.randomUUID(), chatId, original, input, clearInput: current.clearInput, started: false }
      active = attempt
      setDraft('')
      await waitForEmptyComposer(input, draftLabel)
      if (disposed || ctx.getActiveChat().chatId !== chatId) throw new Error('The active chat changed.')
      await request('guide:arm', { chatId, token: attempt.token, input: original })
      if (disposed || active !== attempt || ctx.getActiveChat().chatId !== chatId) throw new Error('The guide was cancelled or the active chat changed.')
      // Read the current button again: React can replace Send with Stop while
      // waiting for the backend, or an attachment can arrive in the meantime.
      const nativeSend = freshReplyButton(input, draftLabel)
      const selected = attempt
      selected.watchdog = setTimeout(() => {
        if (active !== selected || selected.started) return
        void request('guide:cancel', { chatId, token: selected.token }).catch(() => {})
        restore(selected); release(selected)
        fail('The native generation did not confirm its start. Check the connection and try again.')
      }, 16000)
      nativeSend.click()
      status.textContent = 'Waiting for the native generation…'
    } catch (error) {
      if (attempt && !attempt.started) {
        if (!disposed) void request('guide:cancel', { chatId: attempt.chatId, token: attempt.token }).catch(() => {})
        restore(attempt); release(attempt)
      }
      if (!disposed) fail(error instanceof Error ? error.message : 'Guide Response failed.')
    } finally {
      if (!active) busy = false
      toolbar.refresh()
    }
  }
  return () => {
    if (disposed) return
    if (active) {
      if (!active.started) {
        try { ctx.sendToBackend({ type: 'guide:cancel', chatId: active.chatId, token: active.token }) } catch {}
        restore(active)
      }
      clearTimeout(active.watchdog)
    }
    disposed = true
    simpleController?.abort()
    clearTimeout(saveTimer)
    toolbar.destroy(); template.destroy(); role.destroy(); clear.destroy()
    root.replaceChildren(); unsubscribe()
    for (const waiter of waiting.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Extension unloaded.')) }
    waiting.clear()
  }
}
