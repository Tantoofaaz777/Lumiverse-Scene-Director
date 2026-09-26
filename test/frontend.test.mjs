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
  let suite = options.suite ?? 'missing'
  const registered = new Map(), registrations = []
  const suitePending = [], suiteSignals = []
  let suiteRequests = 0
  let finishQueue
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  const nativeFetch = (url, init) => {
    if (url === '/api/v1/spindle') {
      suiteRequests++
      if (suite === 'unavailable') return Promise.reject(new Error('Offline'))
      const data = { extensions: suite === 'missing' ? [] : [{ identifier: 'lumiverse_suite', enabled: suite === 'active', has_frontend: true }] }
      if (options.delaySuite) return new Promise((resolve, reject) => {
        suiteSignals.push(init.signal)
        const abort = () => reject(new Error('Aborted'))
        init.signal.addEventListener('abort', abort, { once: true })
        suitePending.push(() => {
          init.signal.removeEventListener('abort', abort)
          resolve({ ok: true, json: async () => data })
        })
      })
      return Promise.resolve({ ok: true, json: async () => data })
    }
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
      registerInputBarAction: config => {
        if (options.failRegistration && registrations.length % 2 === 1) throw new Error('Registration failed')
        const handlers = new Set()
        const action = {
          ...config, actionId: `spindle:test:action:${config.id}:${registrations.length + 1}`,
          setEnabled: value => { action.enabled = value },
          onClick: handler => { handlers.add(handler); return () => handlers.delete(handler) },
          click: () => { for (const handler of handlers) handler() },
          // Keep callback references here to verify they are safe even if a host
          // surface briefly retains a destroyed action during reconciliation.
          destroy: () => { registered.delete(config.id); action.element?.remove() },
          show: () => {
            action.element?.remove()
            const slot = document.createElement('span')
            slot.setAttribute('data-composer-action', `input-action:test:${action.actionId}`)
            const button = document.createElement('button')
            button.textContent = config.label
            button.addEventListener('click', action.click)
            slot.append(button)
            document.querySelector('[data-component="InputArea"]').append(slot)
            action.element = slot
            return button
          },
        }
        registered.set(config.id, action)
        registrations.push(action)
        return action
      },
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
    registered, registrations, suiteRequests: () => suiteRequests,
    suiteSignals, finishSuite: () => suitePending.shift()(),
    setSuite: value => { suite = value; emit('SPINDLE_EXTENSION_STATUS', { operation: 'updated' }) },
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
  assert.deepEqual(save.settings, { version: 2, template: 'Changed {{input}}', clearInput: false, integrateComposer: false })
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
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { delayQueue: true })
  await tick()
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
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const backend = backendHarness()
  const f = fixture(t, { backend, dropLifecycle: true })
  await tick()
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
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const backend = backendHarness()
  const options = { backend }
  const f = fixture(t, options)
  await tick()
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
  assert.ok(f.controls.slice(0, 2).every(control => !control.disabled()))
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
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { skipQueueRequest: true })
  await tick()
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

for (const suite of ['missing', 'disabled', 'unavailable']) {
  test(`composer integration is unavailable with Suite ${suite}, without discarding the preference`, async t => {
    const f = fixture(t, { suite, settings: { integrateComposer: true } })
    await tick()
    assert.equal(f.controls[2].disabled(), true)
    assert.equal(f.controls[2].getValue(), true)
    assert.equal(f.registered.size, 0)
    assert.ok(f.guideButton())
    const expected = { missing: /Install and enable/, disabled: /Enable Lumiverse Suite/, unavailable: /Could not check/ }
    assert.match(document.querySelector('#sd-composer-integration-hint').textContent, expected[suite])
    const control = document.querySelector('[aria-label="Integrate with Customize composer"]')
    assert.equal(control.getAttribute('aria-describedby'), 'sd-composer-integration-hint')
  })
}

test('Suite alone leaves DOM mode; enabling persists the option and registers only two actions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { suite: 'active' })
  await tick()
  assert.equal(f.controls[2].disabled(), false)
  assert.equal(f.controls[2].getValue(), false)
  assert.equal(f.registered.size, 0)
  f.controls[2].edit({ checked: true })
  await tick()
  assert.equal(f.registered.size, 2)
  assert.equal(f.guideButton(), null)
  assert.equal(f.simpleButton(), null)
  t.mock.timers.tick(500); await tick()
  assert.equal(f.sent.find(m => m.type === 'settings:save').settings.integrateComposer, true)
  const old = f.registrations[0]
  f.controls[2].edit({ checked: false }); await tick()
  assert.equal(f.registered.size, 0)
  assert.ok(f.guideButton())
  f.controls[2].edit({ checked: true }); await tick()
  old.click(); await tick()
  assert.equal(f.clicks(), 0)
  f.cleanup()
  assert.equal(f.registered.size, 0)
  assert.ok([...f.eventHandlers.values()].every(handlers => handlers.size === 0))
})

test('Suite disable and re-enable switch modes without changing the saved preference', async t => {
  const f = fixture(t, { suite: 'active', settings: { integrateComposer: true } })
  await tick()
  assert.equal(f.registered.size, 2)
  f.setSuite('disabled'); await tick()
  assert.equal(f.controls[2].disabled(), true)
  assert.equal(f.controls[2].getValue(), true)
  assert.equal(f.registered.size, 0)
  assert.ok(f.guideButton())
  f.setSuite('active'); await tick()
  assert.equal(f.controls[2].disabled(), false)
  assert.equal(f.registered.size, 2)
  assert.equal(f.guideButton(), null)
  assert.equal(f.sent.filter(m => m.type === 'settings:save').length, 0)
})

test('registered guide respects busy and draft guards; switching mode never starts a second generation', async t => {
  const f = fixture(t, { suite: 'active', settings: { integrateComposer: true } })
  await tick()
  const guide = f.registered.get('scene_direction.guide')
  const button = guide.show(); await tick()
  assert.equal(button.disabled, false)
  guide.click(); guide.click(); await tick()
  assert.equal(f.clicks(), 1)
  assert.equal(button.disabled, true)
  f.registered.get('scene_direction.simple_send').click(); await tick()
  assert.equal(f.clicks(), 1)
  f.setSuite('disabled'); await tick()
  assert.equal(f.guideButton().disabled, true)
  f.notify('guide:failed', 'Provider disconnected'); await tick()
  assert.equal(f.input.value, 'Direction with $&')
  f.idle(''); f.setSuite('active'); await tick()
  const newGuide = f.registered.get('scene_direction.guide')
  newGuide.click(); await tick()
  assert.equal(f.clicks(), 1)
  assert.equal(newGuide.enabled, false)
})

test('hiding registered composer buttons does not reinsert the DOM toolbar or alter registrations', async t => {
  const f = fixture(t, { suite: 'active', settings: { integrateComposer: true } })
  await tick()
  const guide = f.registered.get('scene_direction.guide')
  guide.show(); await tick()
  guide.element.remove(); f.idle('Another draft'); await tick()
  assert.equal(document.querySelector('#sd-guide-toolbar'), null)
  assert.equal(f.registrations.length, 2)
  assert.equal(document.querySelector('[data-composer-action]'), null)
})

test('registered Simple Send uses the same save path and leaves recovery accessible on failure', async t => {
  const f = fixture(t, { suite: 'active', settings: { integrateComposer: true }, queueStatus: 500 })
  await tick()
  f.registered.get('scene_direction.simple_send').click(); await tick(); await tick()
  assert.equal(f.clicks(), 1)
  assert.equal(f.sent.some(m => m.type === 'guide:arm'), false)
  assert.ok(f.recoverButton())
  assert.equal(f.simpleButton().hidden, true)
  f.recoverButton().click(); await tick()
  assert.equal(document.querySelector('dialog textarea').value, 'Direction with $&')
})

test('partial registration failure cleans up and falls back to DOM buttons', async t => {
  const f = fixture(t, { suite: 'active', settings: { integrateComposer: true }, failRegistration: true })
  await tick()
  assert.equal(f.registered.size, 0)
  assert.ok(f.guideButton())
  assert.match(document.querySelector('#sd-composer-integration-hint').textContent, /Could not register/)
})

test('Suite query failure falls back and online recheck restores the chosen integration', async t => {
  const f = fixture(t, { suite: 'active', settings: { integrateComposer: true } })
  await tick()
  f.setSuite('unavailable'); await tick()
  assert.ok(f.guideButton())
  assert.equal(f.registered.size, 0)
  f.setSuite('active'); await tick()
  assert.equal(f.registered.size, 2)
  assert.equal(f.guideButton(), null)
  f.cleanup()
  const count = f.suiteRequests()
  window.dispatchEvent(new Event('online')); await tick()
  assert.equal(f.suiteRequests(), count)
})

test('extension changes during an availability query discard the stale result and coalesce a recheck', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { suite: 'active', delaySuite: true, settings: { integrateComposer: true } })
  await tick()
  assert.equal(f.controls[2].disabled(), true)
  f.setSuite('disabled'); f.setSuite('missing')
  assert.equal(f.suiteRequests(), 1)
  f.finishSuite(); await tick()
  assert.equal(f.registered.size, 0)
  t.mock.timers.tick(0); await tick()
  assert.equal(f.suiteRequests(), 2)
  f.finishSuite(); await tick()
  assert.match(document.querySelector('#sd-composer-integration-hint').textContent, /Install and enable/)
  assert.equal(f.registered.size, 0)
})

test('Suite query timeout is recoverable and teardown aborts outstanding queries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const options = { suite: 'active', delaySuite: true, settings: { integrateComposer: true } }
  const f = fixture(t, options)
  await tick()
  t.mock.timers.tick(5000); await tick()
  assert.equal(f.suiteSignals[0].aborted, true)
  assert.match(document.querySelector('#sd-composer-integration-hint').textContent, /Could not check/)
  options.delaySuite = false
  window.dispatchEvent(new Event('online')); await tick()
  assert.equal(f.registered.size, 2)
  options.delaySuite = true
  window.dispatchEvent(new Event('focus')); await tick()
  f.cleanup()
  assert.equal(f.suiteSignals.at(-1).aborted, true)
  f.finishSuite(); await tick()
  assert.equal(f.registered.size, 0)
  assert.equal(document.querySelector('#sd-guide-toolbar'), null)
})
