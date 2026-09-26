import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { setup } from '../dist/frontend.js'
import { DEFAULT_SETTINGS } from '../dist/core.js'
import { tick } from './backend-harness.mjs'

function fixture(t, options = {}) {
  const dom = new JSDOM('<div data-component="InputArea"><div data-test-input-row><div><textarea name="chat-message"></textarea></div><div><button aria-label="Enviar mensagem"><svg class="lucide-send"></svg></button></div></div></div><section id="settings"></section>')
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: fn => { queueMicrotask(fn); return 1 },
  })
  const input = document.querySelector('textarea')
  const send = document.querySelector('button')
  const controls = []
  const sent = [], alerts = []
  const messages = [], eventHandlers = new Map()
  let receiver, clicks = 0, chatId = 'A', extras = options.extras || false
  let starting = false
  const render = () => {
    send.setAttribute('aria-label', starting ? 'Parar geração' : (input.value.trim() || extras) ? 'Enviar mensagem' : 'Gerar nova resposta')
    send.innerHTML = `<svg class="${starting ? 'lucide-square' : 'lucide-send'}"></svg>`
  }
  input.value = options.draft || 'Direction with $&'
  input.addEventListener('input', render)
  window.alert = message => alerts.push(message)
  function notify(type, message) {
    const arm = sent.findLast(m => m.type === 'guide:arm')
    receiver({ type, token: arm.token, chatId: arm.chatId, message })
  }
  const emit = (event, payload) => { for (const handler of eventHandlers.get(event) || []) handler(payload) }
  send.addEventListener('click', event => {
    clicks++
    const queueMod = options.mac ? event.metaKey : event.ctrlKey
    if (queueMod && input.value.trim()) {
      const savedChatId = chatId
      const message = { is_user: true, content: input.value.trim(), name: 'Active persona', extra: extras ? { attachments: ['image'] } : {} }
      input.value = ''; render()
      if (!options.delayQueue) queueMicrotask(() => {
        messages.push(message)
        emit('MESSAGE_SENT', { chatId: savedChatId, message })
      })
      return
    }
    if (!options.ignoreClick) queueMicrotask(() => { starting = true; render(); notify('guide:started') })
  })
  function mount(target, initial) {
    let config = initial
    const element = document.createElement('input')
    target.append(element)
    const handle = {
      getValue: () => config.checked ?? config.value,
      update: next => { config = { ...config, ...next } },
      destroy: () => element.remove(),
      edit: next => { config = { ...config, ...next }; config.onChange() },
      disabled: () => config.disabled,
    }
    controls.push(handle)
    return handle
  }
  function reply(msg) {
    receiver({ requestId: msg.requestId, type: msg.type === 'guide:arm' ? 'guide:armed' : 'settings:result', settings: { ...DEFAULT_SETTINGS, ...options.settings } })
  }
  const ctx = {
    ui: {
      mount: () => document.querySelector('#settings'),
      registerInputBarAction: () => { throw new Error('Guide Response should be directly on the input bar') },
    },
    components: { mountTextArea: mount, mountSelect: mount, mountSwitch: mount },
    getActiveChat: () => ({ chatId }),
    events: { on: (event, handler) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set())
      eventHandlers.get(event).add(handler)
      return () => eventHandlers.get(event).delete(handler)
    } },
    onBackendMessage: fn => { receiver = fn; return () => {} },
    sendToBackend: msg => {
      sent.push(msg)
      if ((options.delayArm && msg.type === 'guide:arm') || (options.delaySettings && msg.type === 'settings:get')) return
      queueMicrotask(() => reply(msg))
    },
  }
  const cleanup = setup(ctx)
  t.after(() => { cleanup(); dom.window.close() })
  return {
    input, send, sent, alerts, controls, cleanup, messages, emit, eventHandlers,
    simpleClick: () => document.querySelector('button[aria-label="Simple Send"]').click(),
    simpleButton: () => document.querySelector('button[aria-label="Simple Send"]'),
    click: () => document.querySelector('#sd-guide-toolbar button').click(), clicks: () => clicks,
    guideButton: () => document.querySelector('#sd-guide-toolbar button'),
    notify, reply,
    switchChat: id => { chatId = id },
    stopButton: () => { starting = true; render() },
    idle: draft => { starting = false; input.value = draft; render(); input.dispatchEvent(new Event('input', { bubbles: true })) },
    addAttachment: () => { extras = true; render() },
  }
}

test('attachments and pending send actions block empty-send and restore the draft', async t => {
  const f = fixture(t, { extras: true })
  await tick(); f.click(); await tick()
  assert.equal(f.clicks(), 0)
  assert.equal(f.sent.some(m => m.type === 'guide:arm'), false)
  assert.equal(f.input.value, 'Direction with $&')
  assert.match(f.alerts[0], /attachments or selected send actions/)
})

test('restores a retained draft only after the native generation confirms its start', async t => {
  const f = fixture(t, { settings: { clearInput: false }, delayArm: true })
  await tick(); f.click(); await tick()
  assert.equal(f.input.value, '')
  f.reply(f.sent.find(m => m.type === 'guide:arm'))
  await tick()
  assert.equal(f.clicks(), 1)
  assert.equal(f.input.value, 'Direction with $&')
  f.notify('guide:consumed'); f.notify('guide:finished')
  assert.deepEqual(f.alerts, [])
})

test('revalidates the live button after arming instead of clicking Stop', async t => {
  const f = fixture(t, { delayArm: true })
  await tick(); f.click(); await tick()
  f.stopButton()
  f.reply(f.sent.find(m => m.type === 'guide:arm'))
  await tick()
  assert.equal(f.clicks(), 0)
  assert.ok(f.sent.some(m => m.type === 'guide:cancel'))
  assert.equal(f.input.value, 'Direction with $&')
})

test('an attachment arriving during arming prevents native send', async t => {
  const f = fixture(t, { delayArm: true })
  await tick(); f.click(); await tick()
  f.addAttachment()
  f.reply(f.sent.find(m => m.type === 'guide:arm')); await tick()
  assert.equal(f.clicks(), 0)
  assert.match(f.alerts[0], /attachments/)
})

test('chat navigation during arming never restores the old draft into the new chat', async t => {
  const f = fixture(t, { delayArm: true })
  await tick(); f.click(); await tick()
  f.switchChat('B')
  f.input.value = 'New chat draft'
  f.reply(f.sent.find(m => m.type === 'guide:arm')); await tick()
  assert.equal(f.clicks(), 0)
  assert.equal(f.input.value, 'New chat draft')
  assert.ok(f.sent.some(m => m.type === 'guide:cancel'))
})

test('ignored click is reported and restores the direction on backend timeout', async t => {
  const f = fixture(t, { ignoreClick: true })
  await tick(); f.click(); await tick()
  assert.equal(f.input.value, '')
  f.notify('guide:failed', 'The native generation did not start.')
  assert.equal(f.input.value, 'Direction with $&')
  assert.match(f.alerts[0], /did not start/)
})

test('loads settings before guiding and flushes unsaved component edits in order', async t => {
  const f = fixture(t, { delaySettings: true })
  f.click(); await tick()
  assert.equal(f.clicks(), 0)
  assert.ok(f.controls.every(control => control.disabled()))
  f.reply(f.sent[0]); await tick()
  f.click(); await tick()
  assert.equal(f.clicks(), 1)
  f.notify('guide:finished')
  // Settings controls are preserved from the formerly hand-edited bundle.
  f.controls[0].edit({ value: 'Changed {{input}}' })
  f.controls[1].edit({ value: 'user' })
  f.controls[2].edit({ checked: false })
  // Put the host back into its idle state with a new draft.
  f.idle('Next direction')
  f.click(); await tick(); await tick()
  const save = f.sent.find(m => m.type === 'settings:save')
  assert.deepEqual(save.settings, { version: 2, template: 'Changed {{input}}', role: 'user', clearInput: false })
  assert.ok(f.sent.indexOf(save) < f.sent.findLastIndex(m => m.type === 'guide:arm'))
})

test('double click starts only one guide and does not overwrite a new draft on failure', async t => {
  const f = fixture(t)
  await tick(); f.click(); f.click(); await tick()
  assert.equal(f.clicks(), 1)
  f.input.value = 'Keep this new text'
  f.notify('guide:failed', 'Provider failed')
  assert.equal(f.input.value, 'Keep this new text')
})

test('unloading during arming cancels, restores safely and never clicks after a late acknowledgement', async t => {
  const f = fixture(t, { delayArm: true })
  await tick(); f.click(); await tick()
  const request = f.sent.find(m => m.type === 'guide:arm')
  f.cleanup()
  f.reply(request)
  await tick()
  assert.equal(f.clicks(), 0)
  assert.equal(f.input.value, 'Direction with $&')
  assert.ok(f.sent.some(m => m.type === 'guide:cancel'))
  assert.deepEqual(f.alerts, [])
})

test('direct toolbar sits before the input row and follows draft and native generation state', async t => {
  const f = fixture(t)
  await tick()
  const toolbar = document.querySelector('#sd-guide-toolbar')
  assert.equal(toolbar.nextElementSibling, document.querySelector('[data-test-input-row]'))
  assert.equal(f.guideButton().getAttribute('aria-label'), 'Guide Response')
  assert.equal(f.guideButton().disabled, false)
  f.idle(''); await tick()
  assert.equal(f.guideButton().disabled, true)
  f.idle('A new direction'); await tick()
  assert.equal(f.guideButton().disabled, false)
  f.stopButton(); await tick()
  assert.equal(f.guideButton().disabled, true)
  assert.equal(f.send.disabled, false)
  f.idle('A new direction'); await tick()
  f.click(); await tick()
  assert.equal(f.guideButton().getAttribute('aria-busy'), 'true')
  assert.equal(f.guideButton().disabled, true)
  f.notify('guide:finished')
  f.idle('Another direction'); await tick()
  assert.equal(f.guideButton().getAttribute('aria-busy'), 'false')
  assert.equal(f.guideButton().disabled, false)
})

test('toolbar survives chat remounts without duplicates or touching another extension toolbar', async t => {
  const f = fixture(t)
  await tick()
  const area = document.querySelector('[data-component="InputArea"]')
  const other = document.createElement('div')
  other.id = 'ri-toolbar'
  area.insertBefore(other, document.querySelector('#sd-guide-toolbar'))
  const toolbar = document.querySelector('#sd-guide-toolbar')
  area.remove(); await tick()
  assert.equal(document.querySelector('#sd-guide-toolbar'), null)
  const replacement = area.cloneNode(true)
  replacement.querySelector('#sd-guide-toolbar')?.remove()
  document.body.prepend(replacement); await tick()
  assert.equal(document.querySelectorAll('#sd-guide-toolbar').length, 1)
  assert.equal(document.querySelector('#sd-guide-toolbar'), toolbar)
  assert.ok(document.querySelector('#ri-toolbar'))
  const nativeRow = replacement.querySelector('[data-test-input-row]')
  assert.equal(toolbar.nextElementSibling, nativeRow)
  f.cleanup(); await tick()
  assert.equal(document.querySelector('#sd-guide-toolbar'), null)
  assert.ok(document.querySelector('#ri-toolbar'))
  assert.equal(nativeRow.isConnected, true)
  replacement.append(document.createElement('span')); await tick()
  assert.equal(document.querySelector('#sd-guide-toolbar'), null)
})

for (const mac of [false, true]) {
  test(`Simple Send saves the native user draft without arming or generating (${mac ? 'macOS' : 'Windows/Linux'})`, async t => {
    const f = fixture(t, { mac, extras: true, settings: { template: 'DO NOT APPLY {{input}}', clearInput: false } })
    await tick(); f.simpleClick(); await tick()
    assert.equal(f.clicks(), 1)
    assert.deepEqual(f.messages, [{ is_user: true, content: 'Direction with $&', name: 'Active persona', extra: { attachments: ['image'] } }])
    assert.equal(f.input.value, '')
    assert.equal(f.sent.some(m => m.type.startsWith('guide:')), false)
    assert.ok(f.send.querySelector('.lucide-send'))
    assert.match(document.querySelector('.sd-status').textContent, /User message saved/)
    assert.equal(f.eventHandlers.get('MESSAGE_SENT').size, 0)
    assert.deepEqual(f.alerts, [])
  })
}

test('Simple Send is independent of guide settings and blocks both extension actions until saved', async t => {
  const f = fixture(t, { delaySettings: true, delayQueue: true })
  f.simpleClick(); f.simpleClick(); await tick()
  assert.equal(f.clicks(), 1)
  f.idle('Next message'); await tick()
  assert.equal(f.simpleButton().disabled, true)
  assert.equal(f.guideButton().disabled, true)
  f.emit('MESSAGE_SENT', { chatId: 'B', message: { is_user: true } })
  f.emit('MESSAGE_SENT', { chatId: 'A', message: { is_user: false } })
  await tick()
  assert.equal(f.simpleButton().disabled, true)
  f.emit('MESSAGE_SENT', { chatId: 'A', message: { is_user: true } })
  await tick()
  assert.equal(f.simpleButton().disabled, false)
  assert.equal(f.input.value, 'Next message')
})

test('Simple Send disables for empty drafts, native generation and an active guide', async t => {
  const f = fixture(t)
  await tick()
  f.idle('  '); await tick(); f.simpleClick()
  assert.equal(f.simpleButton().disabled, true)
  f.idle('Message'); f.stopButton(); await tick(); f.simpleClick()
  assert.equal(f.simpleButton().disabled, true)
  assert.equal(f.clicks(), 0)
  f.idle('Direction'); await tick(); f.click(); await tick()
  assert.equal(f.simpleButton().disabled, true)
  assert.equal(f.messages.length, 0)
})

for (const change of ['chat', 'draft', 'generation', 'unload']) {
  test(`Simple Send revalidates before clicking after ${change} changes`, async t => {
    const f = fixture(t)
    await tick(); f.simpleClick()
    if (change === 'chat') f.switchChat('B')
    if (change === 'draft') f.idle('Changed message')
    if (change === 'generation') f.stopButton()
    if (change === 'unload') f.cleanup()
    await tick()
    assert.equal(f.clicks(), 0)
    assert.equal(f.messages.length, 0)
    if (change === 'unload') assert.deepEqual(f.alerts, [])
    else assert.equal(f.alerts.length, 1)
  })
}

test('unloading a pending Simple Send removes its listener without retrying or restoring the draft', async t => {
  const f = fixture(t, { delayQueue: true })
  await tick(); f.simpleClick(); await tick()
  assert.equal(f.eventHandlers.get('MESSAGE_SENT').size, 1)
  f.cleanup(); await tick()
  assert.equal(f.eventHandlers.get('MESSAGE_SENT').size, 0)
  assert.equal(f.input.value, '')
  assert.equal(f.clicks(), 1)
  assert.deepEqual(f.alerts, [])
})

test('unconfirmed Simple Send reports uncertainty without automatic retry or duplicate draft', async t => {
  const f = fixture(t, { delayQueue: true })
  await tick()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.simpleClick(); await tick()
  t.mock.timers.tick(15000); await tick()
  assert.match(f.alerts[0], /Check the chat history before retrying/)
  assert.equal(f.clicks(), 1)
  assert.equal(f.input.value, '')
  assert.equal(f.eventHandlers.get('MESSAGE_SENT').size, 0)
  f.idle('Another message'); await tick()
  assert.equal(f.simpleButton().disabled, false)
})
