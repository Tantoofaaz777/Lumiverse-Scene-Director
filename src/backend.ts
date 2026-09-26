import { DEFAULT_SETTINGS, PendingGuides, inject, normalizeSettings, renderTemplate } from './core'
import type { Settings } from './core'
declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const pending = new PendingGuides()
const settingsPath = 'settings.json'
async function settings(userId: string): Promise<Settings> {
  return normalizeSettings(await spindle.userStorage.getJson(settingsPath, { fallback: DEFAULT_SETTINGS, userId }))
}

// The published 0.6.36 declarations predate staging's session-routed third
// argument. The staging worker host and frontend-communication docs expose it.
const routed = spindle as typeof spindle & {
  onFrontendMessage(handler: (payload: unknown, userId: string, frontendSessionId?: string) => void): () => void
  sendToFrontend(payload: unknown, userId: string, options: { frontendSessionId?: string }): void
}
routed.onFrontendMessage(async (raw: unknown, userId: string, frontendSessionId?: string) => {
  const msg = raw as { type?: string; requestId?: string; chatId?: string; token?: string; input?: string; settings?: unknown }
  if (!msg || typeof msg.type !== 'string') return
  const reply = (type: string, data: Record<string, unknown> = {}) => routed.sendToFrontend({ type, requestId: msg.requestId, ...data }, userId, { frontendSessionId })
  try {
    if (msg.type === 'settings:get') { reply('settings:result', { settings: await settings(userId) }); return }
    if (msg.type === 'settings:save') {
      const next = normalizeSettings(msg.settings)
      await spindle.userStorage.setJson(settingsPath, next, { userId })
      reply('settings:result', { settings: next }); return
    }
    if (msg.type === 'guide:cancel' && msg.chatId && msg.token) {
      pending.cancel(userId, msg.chatId, msg.token); reply('guide:cancelled'); return
    }
    if (msg.type !== 'guide:arm') return
    if (!frontendSessionId) throw new Error('This Lumiverse version cannot bind a guide to the active browser session.')
    if (!msg.chatId || !msg.token || typeof msg.input !== 'string' || !msg.input.trim()) throw new Error('Enter a scene direction first.')
    const config = await settings(userId)
    renderTemplate(config.template, msg.input)
    pending.arm({ userId, chatId: msg.chatId, sessionId: frontendSessionId, token: msg.token, input: msg.input, settings: config, expiresAt: Date.now() + 15000 })
    reply('guide:armed')
  } catch (error) { reply('error', { message: error instanceof Error ? error.message : 'Scene Direction failed.' }) }
})

spindle.registerInterceptor(async (messages, context) => {
  const ctx = context as { userId?: string; chatId?: string; frontendSessionId?: string; generationType?: string; dryRun?: boolean }
  const guide = ctx.userId && ctx.chatId
    ? pending.consume(ctx.userId, ctx.chatId, ctx.frontendSessionId, ctx.generationType ?? '', ctx.dryRun)
    : undefined
  return guide ? inject(messages, guide) : messages
}, { priority: 100, required: true } as unknown as Parameters<typeof spindle.registerInterceptor>[1])
