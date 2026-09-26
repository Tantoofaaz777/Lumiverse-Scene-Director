import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { DEFAULT_TEMPLATE, DEFAULT_SETTINGS, normalizeSettings } from './core'
import type { Settings } from './core'
import { composer, readDraft, setDraft, waitForEmptyComposer, freshReplyButton } from './composer'
import { mountGuideToolbar } from './toolbar'
import { simpleSend } from './simple-send'
import { draftRecovery } from './draft-recovery'
import { composerActions } from './composer-actions'
import { watchSuite } from './suite'
import type { SuiteStatus } from './suite'

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
    .sd-control { display: flex; align-items: center; justify-content: flex-end; flex: 0 0 auto; }
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
    @media (max-width: 520px) { .sd-row { gap: 10px; } }
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
  const clearRow = document.createElement("div");
  clearRow.className = "sd-row";
  const clearSlot = document.createElement("div");
  clearSlot.className = "sd-control";
  clearRow.append(label("Clear Input After Guide", "Remove the direction from the chat draft after use."), clearSlot);
  const integrationRow = document.createElement('div')
  integrationRow.className = 'sd-row'
  const integrationSlot = document.createElement('div')
  integrationSlot.className = 'sd-control'
  const integrationLabel = label('Integrate with Customize composer', 'Checking Lumiverse Suite…')
  const integrationHint = integrationLabel.querySelector('.sd-hint')!
  integrationHint.id = 'sd-composer-integration-hint'
  integrationRow.append(integrationLabel, integrationSlot)
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
  panel.append(heading, intro, templateRow, clearRow, integrationRow, actions);
  root.append(style, panel);
  const template = ctx.components.mountTextArea(templateSlot, { value: DEFAULT_TEMPLATE, rows: 6, ariaLabel: "Prompt Template", disabled: true, onChange: () => scheduleSave() });
  const clear = ctx.components.mountSwitch(clearSlot, { checked: true, ariaLabel: "Clear Input After Guide", disabled: true, onChange: () => scheduleSave() });
  const integration = ctx.components.mountSwitch(integrationSlot, {
    checked: false, ariaLabel: 'Integrate with Customize composer', disabled: true,
    onChange: () => { scheduleSave(); reconcileIntegration() },
  })
  // The inspected host bridge drops ariaLabel. Label the actual asynchronous
  // control, including any replacement mounted by React, until it is fixed.
  const labelSwitch = () => {
    for (const [slot, name] of [[clearSlot, 'Clear Input After Guide'], [integrationSlot, 'Integrate with Customize composer']] as const) {
      const button = slot.querySelector('[role="switch"]')
      if (button && button.getAttribute('aria-label') !== name) button.setAttribute('aria-label', name)
      if (slot === integrationSlot && button && button.getAttribute('aria-describedby') !== integrationHint.id) button.setAttribute('aria-describedby', integrationHint.id)
    }
  }
  const switchObserver = new MutationObserver(labelSwitch)
  switchObserver.observe(clearSlot, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-label'] })
  switchObserver.observe(integrationSlot, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-label', 'aria-describedby'] })
  labelSwitch()
  let current: Settings = DEFAULT_SETTINGS
  let disposed = false
  let busy = false
  let simpleController: AbortController | undefined
  let settingsReady = false
  let suiteStatus: SuiteStatus = 'checking'
  let settingsLoad: Promise<void> | undefined
  let settingsRetry: ReturnType<typeof setTimeout> | undefined
  let settingsDirty = false
  let settingsRevision = 0
  let saving = 0
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveTail: Promise<void> = Promise.resolve()
  type Reply = { type?: string; requestId?: string; message?: string; settings?: unknown; token?: string; chatId?: string }
  type ActiveGuide = { token: string; chatId: string; original: string; input: HTMLTextAreaElement; clearInput: boolean; started: boolean; tracking?: boolean; polling?: boolean; recoveryTimer?: ReturnType<typeof setTimeout> }
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
    clearTimeout(guide.recoveryTimer)
    if (active === guide) { active = undefined; busy = false }
    toolbar.refresh()
  }
  function fail(message: string) {
    status.textContent = message
    window.alert(message)
  }
  async function recover(guide: ActiveGuide) {
    if (disposed || active !== guide || !guide.tracking || guide.polling) return
    clearTimeout(guide.recoveryTimer)
    guide.polling = true
    try {
      // The normal message handler processes the correlated status reply too.
      await request('guide:status', { chatId: guide.chatId, token: guide.token })
    } catch {
      // A transport timeout is not a generation failure. Wait for the backend
      // to confirm the outcome after reconnecting; never resend automatically.
    } finally {
      guide.polling = false
      if (!disposed && active === guide) scheduleRecovery(guide)
    }
  }
  function scheduleRecovery(guide: ActiveGuide) {
    clearTimeout(guide.recoveryTimer)
    guide.recoveryTimer = setTimeout(() => { void recover(guide) }, 5000)
  }
  const recoverOnReturn = () => {
    if (disposed) return
    if (active) void recover(active)
    if (!settingsReady) void loadSettings().catch(() => {})
    else if (settingsDirty && !saving) void persist().catch(() => {})
  }
  const recoverOnVisible = () => { if (document.visibilityState === 'visible') recoverOnReturn() }
  window.addEventListener('online', recoverOnReturn)
  window.addEventListener('focus', recoverOnReturn)
  document.addEventListener('visibilitychange', recoverOnVisible)
  const unsubscribe = ctx.onBackendMessage(raw => {
    const msg = raw as Reply
    if (!msg) return
    if (active && msg.token === active.token && msg.chatId === active.chatId) {
      const guide = active
      if (msg.type === 'guide:started') {
        if (!guide.started && !guide.clearInput) restore(guide)
        guide.started = true
        status.textContent = 'Preparing the guided response…'
      } else if (msg.type === 'guide:consumed') {
        if (!guide.started && !guide.clearInput) restore(guide)
        guide.started = true
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
    return normalizeSettings({ version: 2, template: template.getValue(), clearInput: clear.getValue(), integrateComposer: integration.getValue() })
  }
  function show(value: Settings) {
    current = value
    template.update({ value: value.template })
    clear.update({ checked: value.clearInput })
    integration.update({ checked: value.integrateComposer })
  }
  function persist(override?: Settings): Promise<void> {
    clearTimeout(saveTimer); saveTimer = undefined
    const next = override ?? snapshot()
    const revision = settingsRevision
    settingsDirty = true
    saving++
    status.textContent = 'Saving…'
    const operation = saveTail.then(async () => {
      await request('settings:save', { settings: next })
      current = next
      if (revision === settingsRevision) {
        settingsDirty = false
        if (!disposed) status.textContent = 'Saved.'
      }
    }).catch(error => {
      if (!disposed) status.textContent = error.message
      throw error
    }).finally(() => { saving-- })
    // Keep the queue usable after a failure; the dirty flag drives retries.
    saveTail = operation.catch(() => {})
    return operation
  }
  function scheduleSave() {
    settingsDirty = true
    settingsRevision++
    clearTimeout(saveTimer)
    status.textContent = 'Unsaved changes'
    saveTimer = setTimeout(() => { void persist().catch(() => {}) }, 500)
  }
  reset.disabled = true
  reset.addEventListener('click', () => {
    const next = { ...snapshot(), template: DEFAULT_TEMPLATE }
    template.update({ value: DEFAULT_TEMPLATE })
    settingsRevision++
    void persist(next).catch(() => {})
  })
  function loadSettings(): Promise<void> {
    if (disposed || settingsReady) return Promise.resolve()
    if (settingsLoad) return settingsLoad
    clearTimeout(settingsRetry)
    settingsLoad = request('settings:get').then(result => {
      if (disposed) return
      show(normalizeSettings(result.settings))
      template.update({ disabled: false }); clear.update({ disabled: false })
      reset.disabled = false
      settingsReady = true
      status.textContent = ''
      reconcileIntegration()
      toolbar.refresh()
    }).catch(error => {
      if (!disposed) {
        status.textContent = error.message
        settingsRetry = setTimeout(() => { void loadSettings().catch(() => {}) }, 5000)
      }
      throw error
    }).finally(() => { settingsLoad = undefined })
    return settingsLoad
  }

  const nativeActions = composerActions(ctx, () => ({ ready: settingsReady, busy }), () => { void guide() }, () => { void sendOnly() })
  const drafts = draftRecovery(ctx, () => toolbar.refresh())
  const toolbar = mountGuideToolbar(() => { void guide() }, () => { void sendOnly() }, () => ({ ready: settingsReady, busy, drafts: drafts.count(), integrated: nativeActions.active() }), () => drafts.open(), () => nativeActions.refresh())
  function reconcileIntegration() {
    if (disposed) return
    const available = suiteStatus === 'active' && typeof ctx.ui.registerInputBarAction === 'function'
    integration.update({ disabled: !settingsReady || !available })
    const hints: Record<SuiteStatus, string> = {
      checking: 'Checking Lumiverse Suite…',
      missing: 'Install and enable Lumiverse Suite to use this option. Using the standard button bar.',
      disabled: 'Enable Lumiverse Suite to use this option. Using the standard button bar.',
      unavailable: 'Could not check Lumiverse Suite. Using the standard button bar; checking again automatically.',
      active: 'Enable to register Guide Response and Simple Send, then add and arrange them in Customize composer. Off keeps the standard button bar.',
    }
    integrationHint.textContent = suiteStatus === 'active' && !available ? 'This Lumiverse version does not support input action registration. Using the standard button bar.' : hints[suiteStatus]
    try { nativeActions.setActive(settingsReady && available && integration.getValue()) }
    catch { integrationHint.textContent = 'Could not register composer actions. Using the standard button bar. Toggle this option to retry.' }
    toolbar.refresh()
  }
  const stopWatchingSuite = watchSuite(ctx, value => { suiteStatus = value; reconcileIntegration() })
  void loadSettings().catch(() => {})
  async function sendOnly() {
    if (busy || disposed) return
    busy = true
    const controller = new AbortController()
    simpleController = controller
    toolbar.refresh()
    try {
      status.textContent = 'Sending your message…'
      await simpleSend(ctx, controller.signal, drafts)
      if (!disposed && status.textContent === 'Sending your message…') status.textContent = ''
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
      await loadSettings()
      await saveTail
      if (saveTimer || settingsDirty) await persist()
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
      attempt.tracking = true
      scheduleRecovery(attempt)
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
      clearTimeout(active.recoveryTimer)
    }
    disposed = true
    simpleController?.abort()
    window.removeEventListener('online', recoverOnReturn)
    window.removeEventListener('focus', recoverOnReturn)
    document.removeEventListener('visibilitychange', recoverOnVisible)
    clearTimeout(saveTimer)
    clearTimeout(settingsRetry)
    switchObserver.disconnect()
    stopWatchingSuite()
    toolbar.destroy(); nativeActions.destroy(); drafts.destroy(); template.destroy(); clear.destroy(); integration.destroy()
    root.replaceChildren(); unsubscribe()
    for (const waiter of waiting.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Extension unloaded.')) }
    waiting.clear()
  }
}
