import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { setup } from '../dist/frontend.js'
import { DEFAULT_SETTINGS } from '../dist/core.js'
import { backendHarness, tick } from './backend-harness.mjs'

function fixture(t, options = {}) {
  const dom = new JSDOM('<div data-component="InputArea"><div data-test-input-row><div><textarea name="chat-message"></textarea></div><div><button aria-label="Enviar mensagem"><svg class="lucide-send"></svg></button></div></div></div><section id="settings"></section>', { url: 'https://lumiverse.test/chat' })
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
  const requests = []
  let finishQueue
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  const nativeFetch = (url, init) => {
    requests.push({ url, init })
    return new Promise((resolve, reject) => {
      finishQueue = (status = 200) => {
        if (status === 0) { reject(new Error('Network disconnected')); return }
        const message = { ...JSON.parse(init.body), chat_id: chatId, id: 'saved-message' }
        const response = { ok: status === 200, status, json: async () => message, clone: () => ({ json: async () => message }) }
        resolve(response)
      }
      if (!options.delayQueue) queueMicrotask(() => finishQueue(options.queueStatus ?? 200))
    })
  }
  window.fetch = nativeFetch
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
    if (options.backend && type === 'guide:started') { options.backend.event('GENERATION_STARTED'); return }
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
      if (options.skipQueueRequest) return
      void window.fetch(`/api/v1/chats/${savedChatId}/messages`, { method: 'POST', body: JSON.stringify(message) }).then(response => {
        if (response.ok) {
          messages.push(message)
          emit('MESSAGE_SENT', { chatId: savedChatId, message })
        }
      }).catch(() => {})
      return
    }
    if (!options.ignoreClick) queueMicrotask(() => { starting = true; render(); notify('guide:started') })
  })
  function mount(target, initial) {
    let config = initial
    const element = document.createElement(initial.checked === undefined ? 'input' : 'button')
    if (initial.checked !== undefined) element.setAttribute('role', 'switch')
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
    components: { mountTextArea: mount, mountSwitch: mount },
    getActiveChat: () => ({ chatId }),
    events: { on: (event, handler) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, new Set())
      eventHandlers.get(event).add(handler)
      return () => eventHandlers.get(event).delete(handler)
    } },
    onBackendMessage: fn => { receiver = fn; return () => {} },
    sendToBackend: msg => {
      sent.push(msg)
      if (options.backend) {
        if (!options.offline) void options.backend.receive(msg)
        return
      }
      if ((options.delayArm && msg.type === 'guide:arm') || (options.delaySettings && msg.type === 'settings:get')) return
      queueMicrotask(() => reply(msg))
    },
  }
  if (options.backend) options.backend.api.sendToFrontend = payload => {
    if (!options.offline && (!options.dropLifecycle || payload.requestId)) receiver(payload)
  }
  let cleanup = setup(ctx)
  t.after(() => { cleanup(); dom.window.close() })
  return {
    input, send, sent, alerts, controls, cleanup: () => cleanup(), messages, emit, eventHandlers, requests, nativeFetch,
    finishQueue: status => finishQueue(status),
    reload: () => { cleanup(); cleanup = setup(ctx) },
    recoverButton: () => document.querySelector('button[aria-label="Recover draft"]'),
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
  f.controls[1].edit({ checked: false })
  // Put the host back into its idle state with a new draft.
  f.idle('Next direction')
  f.click(); await tick(); await tick()
  const save = f.sent.find(m => m.type === 'settings:save')
  assert.deepEqual(save.settings, { version: 2, template: 'Changed {{input}}', clearInput: false })
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
    assert.equal(document.querySelector('.sd-status').textContent, '')
    assert.equal(f.recoverButton().hidden, true)
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
  assert.equal(f.simpleButton().disabled, true)
  f.finishQueue()
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

test('unloading a pending Simple Send preserves a recoverable copy without retrying', async t => {
  const f = fixture(t, { delayQueue: true })
  await tick(); f.simpleClick(); await tick()
  assert.equal(window.fetch, f.nativeFetch)
  f.cleanup(); await tick()
  assert.equal(JSON.parse(window.sessionStorage.getItem('scene-direction:simple-send-drafts')).length, 1)
  assert.equal(f.input.value, '')
  assert.equal(f.clicks(), 1)
  assert.deepEqual(f.alerts, [])
})

test('unconfirmed Simple Send reports uncertainty without automatic retry or duplicate draft', async t => {
  const f = fixture(t, { delayQueue: true })
  await tick()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.simpleClick(); await tick()
  t.mock.timers.tick(35000); await tick()
  assert.match(f.alerts[0], /Check the chat history before retrying/)
  assert.equal(f.clicks(), 1)
  assert.equal(f.input.value, '')
  assert.equal(f.recoverButton().hidden, false)
  f.idle('Another message'); await tick()
  assert.equal(f.simpleButton().disabled, false)
})

for (const outcome of ['failed', 'finished', 'stopped']) {
  test(`reconnect recovers a lost ${outcome} event from the real backend without another generation`, async t => {
    const backend = backendHarness()
    const options = { backend }
    const f = fixture(t, options)
    await tick(); f.click(); await tick(); await tick()
    assert.equal(f.clicks(), 1)
    await backend.intercept()
    options.offline = true
    backend.event(outcome === 'stopped' ? 'GENERATION_STOPPED' : 'GENERATION_ENDED', outcome === 'failed' ? { errorMessage: 'Provider disconnected' } : {})
    f.idle(''); await tick()
    assert.equal(f.guideButton().getAttribute('aria-busy'), 'true')
    options.offline = false
    window.dispatchEvent(new Event('online')); await tick()
    assert.equal(f.guideButton().getAttribute('aria-busy'), 'false')
    assert.equal(f.input.value, outcome === 'finished' ? '' : 'Direction with $&')
    assert.equal(f.alerts.length, outcome === 'finished' ? 0 : 1)
    if (outcome !== 'finished') {
      assert.equal(f.simpleButton().disabled, false)
      assert.equal(f.guideButton().disabled, false)
    }
    assert.equal(f.clicks(), 1)
    assert.equal(f.sent.filter(m => m.type === 'guide:arm').length, 1)
    window.dispatchEvent(new Event('focus')); await tick()
    assert.equal(f.sent.filter(m => m.type === 'guide:status').length, 1)
  })
}

test('polling recovers missed start and completion, and never expires a still-running guide', async t => {
  const backend = backendHarness()
  const f = fixture(t, { backend, dropLifecycle: true })
  await tick()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.click(); await tick()
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(5000); await tick() }
  assert.equal(f.guideButton().getAttribute('aria-busy'), 'true')
  assert.deepEqual(f.alerts, [])
  await backend.intercept()
  backend.event('GENERATION_ENDED')
  f.idle('New draft'); await tick()
  t.mock.timers.tick(5000); await tick()
  assert.equal(f.guideButton().disabled, false)
  assert.equal(f.input.value, 'New draft')
  assert.equal(f.clicks(), 1)
})

test('transport timeouts keep recovery pending and retry after reconnect without duplicate polling', async t => {
  const backend = backendHarness()
  const options = { backend }
  const f = fixture(t, options)
  await tick()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.click(); await tick(); await tick(); await backend.intercept()
  options.offline = true
  t.mock.timers.tick(5000); await tick()
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await tick()
  assert.equal(f.sent.filter(m => m.type === 'guide:status').length, 1)
  t.mock.timers.tick(5000); await tick()
  assert.deepEqual(f.alerts, [])
  assert.equal(f.guideButton().getAttribute('aria-busy'), 'true')
  backend.event('GENERATION_ENDED', { errorMessage: 'Failed offline' })
  options.offline = false
  t.mock.timers.tick(5000); await tick()
  assert.equal(f.alerts[0], 'Failed offline')
  assert.equal(f.input.value, 'Direction with $&')
  assert.equal(f.clicks(), 1)
})

test('recovery preserves newer drafts, survives backend state loss and stops on unload', async t => {
  const backend = backendHarness()
  const options = { backend }
  const f = fixture(t, options)
  await tick(); f.click(); await tick(); await tick()
  const restarted = backendHarness()
  restarted.api.sendToFrontend = backend.api.sendToFrontend
  options.backend = restarted
  f.idle('Keep my new draft'); await tick()
  window.dispatchEvent(new Event('focus')); await tick()
  assert.match(f.alerts[0], /no longer available/)
  assert.equal(f.input.value, 'Keep my new draft')
  assert.equal(f.simpleButton().disabled, false)
  f.click(); await tick(); await tick()
  f.cleanup()
  const count = f.sent.length
  window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); await tick()
  assert.equal(f.sent.length, count)
})

test('repeated recovery does not restore an intentionally erased retained draft', async t => {
  const backend = backendHarness()
  backend.api.userStorage.getJson = async () => ({ ...DEFAULT_SETTINGS, clearInput: false })
  const f = fixture(t, { backend })
  await tick(); f.click(); await tick(); await tick()
  assert.equal(f.input.value, 'Direction with $&')
  f.input.value = ''
  await backend.intercept()
  window.dispatchEvent(new Event('focus')); await tick()
  assert.equal(f.input.value, '')
  assert.equal(f.guideButton().getAttribute('aria-busy'), 'true')
})

test('a delayed recovery reply cannot release or restore over a newer guide', async t => {
  const backend = backendHarness()
  const f = fixture(t, { backend })
  await tick(); f.click(); await tick(); await tick()
  const deliver = backend.api.sendToFrontend
  let delayed
  backend.api.sendToFrontend = payload => {
    if (payload.requestId && payload.type === 'guide:started') delayed = payload
    else deliver(payload)
  }
  window.dispatchEvent(new Event('focus')); await tick()
  assert.ok(delayed)
  await backend.intercept()
  backend.event('GENERATION_ENDED')
  f.idle('New guide'); await tick(); f.click(); await tick(); await tick()
  deliver(delayed); await tick()
  assert.equal(f.input.value, '')
  assert.equal(f.guideButton().getAttribute('aria-busy'), 'true')
  assert.equal(f.clicks(), 2)
  assert.deepEqual(f.alerts, [])
})

test('settings load retries after timeout and ignores the expired response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const options = { delaySettings: true }
  const f = fixture(t, options)
  const first = f.sent[0]
  t.mock.timers.tick(5001); await tick()
  f.reply(first); await tick()
  assert.ok(f.controls.every(control => control.disabled()))
  options.delaySettings = false
  window.dispatchEvent(new Event('online')); await tick()
  assert.equal(f.sent.filter(m => m.type === 'settings:get').length, 2)
  assert.ok(f.controls.every(control => !control.disabled()))
  assert.equal(f.guideButton().disabled, false)
  t.mock.timers.tick(5000); await tick()
  assert.equal(f.sent.filter(m => m.type === 'settings:get').length, 2)
})

test('settings load also retries automatically and stops retrying on teardown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { delaySettings: true })
  t.mock.timers.tick(5000); await tick()
  t.mock.timers.tick(5000); await tick()
  assert.equal(f.sent.filter(m => m.type === 'settings:get').length, 2)
  f.cleanup(); await tick()
  t.mock.timers.tick(20000); await tick()
  assert.equal(f.sent.filter(m => m.type === 'settings:get').length, 2)
})

test('failed settings save retries the dirty snapshot when guiding without another edit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const backend = backendHarness()
  let writes = 0
  backend.api.userStorage.setJson = async () => { writes++; throw new Error('Storage unavailable') }
  const f = fixture(t, { backend })
  await tick()
  f.controls[0].edit({ value: 'Retry {{input}}' })
  t.mock.timers.tick(500); await tick()
  let saved
  backend.api.userStorage.setJson = async (_path, value) => { writes++; saved = value }
  f.click(); await tick(); await tick(); await tick()
  assert.equal(writes, 2)
  assert.equal(saved.template, 'Retry {{input}}')
  assert.equal('role' in saved, false)
  assert.equal(f.clicks(), 1)
  assert.deepEqual(f.alerts, [])
})

test('unsaved settings retry on reconnect and retain newer edits while an older save completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const backend = backendHarness()
  let release
  backend.api.userStorage.setJson = () => new Promise(resolve => { release = resolve })
  const f = fixture(t, { backend })
  await tick()
  f.controls[0].edit({ value: 'First' })
  t.mock.timers.tick(500); await tick()
  f.controls[0].edit({ value: 'Second' })
  release(); await tick()
  assert.notEqual(document.querySelector('.sd-status').textContent, 'Saved.')
  let saved
  backend.api.userStorage.setJson = async (_path, value) => { saved = value }
  window.dispatchEvent(new Event('online')); await tick(); await tick()
  assert.equal(saved.template, 'Second')
})

test('Simple Send ignores broadcasts even for identical content and uses its own HTTP response', async t => {
  const f = fixture(t, { delayQueue: true })
  await tick(); f.simpleClick(); await tick()
  assert.equal(window.fetch, f.nativeFetch)
  f.idle('New draft'); await tick()
  for (const content of ['Other message', 'Direction with $&']) {
    f.emit('MESSAGE_SENT', { chatId: 'A', message: { id: 'another-tab', is_user: true, content } })
    await tick()
    assert.equal(f.simpleButton().disabled, true)
  }
  f.finishQueue(); await tick()
  assert.equal(f.simpleButton().disabled, false)
  assert.equal(f.recoverButton().hidden, true)
  assert.equal(f.input.value, 'New draft')
})

for (const queueStatus of [500, 0]) {
  test(`failed Simple Send (${queueStatus}) keeps text across remount and restores only on request`, async t => {
    const f = fixture(t, { queueStatus })
    await tick(); f.simpleClick(); await tick()
    assert.equal(f.messages.length, 0)
    assert.equal(f.input.value, '')
    assert.equal(f.recoverButton().hidden, false)
    f.reload(); await tick()
    assert.equal(f.recoverButton().hidden, false)
    f.recoverButton().click()
    assert.equal(document.querySelector('.sd-draft-recovery textarea').value, 'Direction with $&')
    document.querySelector('.sd-draft-recovery section button').click(); await tick()
    assert.equal(f.input.value, 'Direction with $&')
    assert.equal(f.recoverButton().hidden, true)
    assert.equal(f.clicks(), 1)
    assert.equal(document.querySelector('.sd-draft-recovery'), null)
  })
}

test('Recover draft never overwrites another draft or another chat', async t => {
  const f = fixture(t, { queueStatus: 500 })
  await tick(); f.simpleClick(); await tick()
  f.idle('New text'); await tick()
  f.recoverButton().click()
  const restore = document.querySelector('.sd-draft-recovery section button')
  restore.click()
  assert.equal(f.input.value, 'New text')
  f.switchChat('B'); f.idle(''); await tick()
  restore.click()
  assert.equal(f.input.value, '')
  assert.equal(f.recoverButton().hidden, true)
  assert.equal(JSON.parse(window.sessionStorage.getItem('scene-direction:simple-send-drafts')).length, 1)
})

test('missing native save request times out and removes the temporary transport observer', async t => {
  const f = fixture(t, { skipQueueRequest: true })
  await tick()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.simpleClick(); await tick()
  assert.notEqual(window.fetch, f.nativeFetch)
  t.mock.timers.tick(15000); await tick()
  assert.equal(window.fetch, f.nativeFetch)
  assert.equal(f.recoverButton().hidden, false)
  assert.equal(f.clicks(), 1)
})

test('storage failure prevents Simple Send from clearing or submitting the draft', async t => {
  const f = fixture(t)
  await tick()
  const originalSet = window.Storage.prototype.setItem
  window.Storage.prototype.setItem = () => { throw new Error('Storage full') }
  f.simpleClick(); await tick()
  window.Storage.prototype.setItem = originalSet
  assert.equal(f.clicks(), 0)
  assert.equal(f.input.value, 'Direction with $&')
  assert.equal(f.alerts[0], 'Storage full')
})

test('the native switch receives its accessible name even when the host remounts it', async t => {
  const f = fixture(t)
  await tick()
  const control = document.querySelector('[role="switch"]')
  assert.equal(control.getAttribute('aria-label'), 'Clear Input After Guide')
  const replacement = document.createElement('button')
  replacement.setAttribute('role', 'switch')
  control.replaceWith(replacement); await tick()
  assert.equal(replacement.getAttribute('aria-label'), 'Clear Input After Guide')
  f.cleanup()
})
