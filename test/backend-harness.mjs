import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { DEFAULT_SETTINGS } from '../dist/core.js'

export function backendHarness() {
  let clock = 1000
  let handler, interceptor
  const timers = new Map()
  const events = new Map()
  const replies = []
  const api = {
    host: { capabilities: { 'frontend-session-origin-v1': 1, 'required-interceptors-v1': 1 } },
    permissions: { getGranted: async () => ['interceptor', 'generation'] },
    userStorage: { getJson: async () => DEFAULT_SETTINGS, setJson: async () => {} },
    onFrontendMessage: fn => { handler = fn },
    sendToFrontend: (payload, userId, options) => { replies.push({ payload, userId, options }) },
    on: (type, fn) => { events.set(type, fn); return () => events.delete(type) },
    registerInterceptor: fn => { interceptor = fn },
  }
  runInNewContext(readFileSync(new URL('../dist/backend.js', import.meta.url), 'utf8'), {
    spindle: api,
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { const id = {}; timers.set(id, { fn, at: clock + ms }); return id },
    clearTimeout: id => timers.delete(id),
  })
  return {
    api, replies, timers,
    receive: (msg, user = 'u', session = 's') => handler(msg, user, session),
    intercept: (ctx = {}, messages = []) => interceptor(messages, { userId: 'u', chatId: 'A', frontendSessionId: 's', generationType: 'normal', dryRun: false, ...ctx }),
    event: (type, data = {}, user = 'u') => events.get(type)?.({ chatId: 'A', generationId: 'g', frontendSessionId: 's', generationType: 'normal', ...data }, user),
    advance(ms) {
      clock += ms
      for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn() }
    },
  }
}
export const arm = { type: 'guide:arm', requestId: 'arm', chatId: 'A', token: 't', input: 'A literal $& direction' }
export const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
