import { DEFAULT_SETTINGS, PendingGuides, START_TIMEOUT_MS, inject, normalizeSettings, renderTemplate } from './core'
import type { Pending, Settings } from './core'
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const pending = new PendingGuides()
const timers = new Map<Pending, ReturnType<typeof setTimeout>>()
const settingsPath = 'settings.json'
// Terminal receipts survive a lost frontend notification without rearming.
type Receipt = { type: 'guide:failed' | 'guide:finished'; message?: string; at: number }
const receipts = new Map<string, Receipt>()
const receiptKey = (userId: string, sessionId: string, chatId: string, token: string) => JSON.stringify([userId, sessionId, chatId, token])
function pruneReceipts() {
  for (const [key, receipt] of receipts) if (Date.now() - receipt.at > 86400000) receipts.delete(key)
  while (receipts.size > 256) receipts.delete(receipts.keys().next().value!)
}
async function settings(userId: string): Promise<Settings> {
  return normalizeSettings(await spindle.userStorage.getJson(settingsPath, { fallback: DEFAULT_SETTINGS, userId }))
}
// Published 0.6.36 declarations lag staging's document routing.
const routed = spindle as typeof spindle & {
  onFrontendMessage(handler: (payload: unknown, userId: string, frontendSessionId?: string) => void): () => void
  sendToFrontend(payload: unknown, userId: string, options: { frontendSessionId?: string }): void
}
function clearTimer(entry: Pending) {
  clearTimeout(timers.get(entry))
  timers.delete(entry)
}
function notify(entry: Pending, type: string, message?: string) {
  routed.sendToFrontend({ type, token: entry.token, chatId: entry.chatId, message }, entry.userId, { frontendSessionId: entry.sessionId })
}
function finish(entry: Pending, message?: string) {
  if (pending.get(entry.userId, entry.chatId) !== entry) return
  pending.cancel(entry.userId, entry.chatId, entry.token)
  clearTimer(entry)
  receipts.set(receiptKey(entry.userId, entry.sessionId, entry.chatId, entry.token), {
    type: message ? 'guide:failed' : 'guide:finished', message, at: Date.now(),
  })
  pruneReceipts()
  notify(entry, message ? 'guide:failed' : 'guide:finished', message)
}

type GenerationEvent = { chatId?: string; generationId?: string; frontendSessionId?: string; generationType?: string; error?: string; errorMessage?: string }
let subscriptions: Array<() => void> = []
function subscribeGenerationEvents() {
  // Install only after permissions are granted. Do not unsubscribe between
  // guides: another user's generation may finish while this one is arming.
  if (subscriptions.length) return
  subscriptions = [
    spindle.on('GENERATION_STARTED', (raw, userId) => {
      const event = raw as GenerationEvent
      if (!userId || !event.chatId || !event.generationId) return
      const entry = pending.start(userId, event.chatId, event.frontendSessionId, event.generationType ?? '', event.generationId)
      if (entry) { clearTimer(entry); notify(entry, 'guide:started') }
    }),
    ...['GENERATION_ENDED', 'GENERATION_STOPPED'].map(type => spindle.on(type, (raw, userId) => {
      const event = raw as GenerationEvent
      if (!userId || !event.chatId) return
      const entry = pending.get(userId, event.chatId)
      if (!entry?.generationId || entry.generationId !== event.generationId) return
      const error = event.error || event.errorMessage || (type === 'GENERATION_STOPPED' ? 'The guided generation was stopped.' : undefined)
      finish(entry, error || (!entry.consumed ? 'The generation ended without applying the scene direction.' : undefined))
    })),
  ]
}

routed.onFrontendMessage(async (raw: unknown, userId: string, frontendSessionId?: string) => {
  if (!raw || typeof raw !== 'object') return
  const msg = raw as { type?: string; requestId?: string; chatId?: string; token?: string; input?: string; settings?: unknown }
  if (typeof msg.type !== 'string') return
  const reply = (type: string, data: Record<string, unknown> = {}) => routed.sendToFrontend({ type, requestId: msg.requestId, ...data }, userId, { frontendSessionId })
  let reservation: Pending | undefined
  try {
    if (msg.type === 'settings:get') { reply('settings:result', { settings: await settings(userId) }); return }
    if (msg.type === 'settings:save') {
      const next = normalizeSettings(msg.settings)
      await spindle.userStorage.setJson(settingsPath, next, { userId })
      reply('settings:result', { settings: next }); return
    }
    if (!frontendSessionId) throw new Error('This Lumiverse version cannot bind a guide to the active browser session.')
    if (typeof msg.chatId !== 'string' || !msg.chatId || typeof msg.token !== 'string' || !msg.token) throw new Error('Invalid guide request.')
    if (msg.type === 'guide:status') {
      pruneReceipts()
      const identity = { chatId: msg.chatId, token: msg.token }
      const receipt = receipts.get(receiptKey(userId, frontendSessionId, msg.chatId, msg.token))
      if (receipt) { reply(receipt.type, { ...identity, message: receipt.message }); return }
      const entry = pending.get(userId, msg.chatId)
      if (entry?.sessionId === frontendSessionId && entry.token === msg.token) {
        reply(entry.consumed ? 'guide:consumed' : entry.generationId ? 'guide:started' : 'guide:pending', identity)
      } else {
        reply('guide:failed', { ...identity, message: 'The guide state is no longer available. Check the chat history before retrying.' })
      }
      return
    }
    if (msg.type === 'guide:cancel') {
      const entry = pending.get(userId, msg.chatId)
      // Do not strip a direction from a generation the host already accepted.
      if (entry && !entry.generationId) {
        const removed = pending.cancel(userId, msg.chatId, msg.token, frontendSessionId)
        if (removed) clearTimer(removed)
      }
      reply('guide:cancelled'); return
    }
    if (msg.type !== 'guide:arm') return
    if (typeof msg.input !== 'string' || !msg.input.trim()) throw new Error('Enter a scene direction first.')
    reservation = { userId, chatId: msg.chatId, sessionId: frontendSessionId, token: msg.token, input: msg.input, expiresAt: Date.now() + START_TIMEOUT_MS }
    pending.arm(reservation)
    const entry = reservation
    timers.set(entry, setTimeout(() => finish(entry, 'The native generation did not start. Your direction was not applied; try again.'), START_TIMEOUT_MS))
    const granted = await spindle.permissions.getGranted()
    if (!granted.includes('generation') || !granted.includes('interceptor')) throw new Error('Enable the generation and interceptor permissions for Scene Direction in Extensions.')
    const capabilities = spindle.host.capabilities as Record<string, number | undefined>
    if (!capabilities['frontend-session-origin-v1'] || !capabilities['required-interceptors-v1']) throw new Error('Update Lumiverse: Scene Direction requires document routing and required interceptors.')
    const config = await settings(userId)
    renderTemplate(config.template, msg.input)
    pending.activate(entry, config)
    subscribeGenerationEvents()
    reply('guide:armed')
  } catch (error) {
    if (reservation && pending.get(userId, reservation.chatId) === reservation) {
      pending.cancel(userId, reservation.chatId, reservation.token)
      clearTimer(reservation)
    }
    reply('error', { message: error instanceof Error ? error.message : 'Scene Direction failed.' })
  }
})

spindle.registerInterceptor(async (messages, context) => {
  const ctx = context as { userId?: string; chatId?: string; frontendSessionId?: string; generationType?: string; dryRun?: boolean }
  const guide = ctx.userId && ctx.chatId
    ? pending.consume(ctx.userId, ctx.chatId, ctx.frontendSessionId, ctx.generationType ?? '', ctx.dryRun)
    : undefined
  if (!guide) return messages
  const result = inject(messages, guide)
  notify(guide, 'guide:consumed')
  return result
}, { priority: 100, required: true } as unknown as Parameters<typeof spindle.registerInterceptor>[1])
