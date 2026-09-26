export const DEFAULT_TEMPLATE = '[Treat the following instruction as explicit scene direction and apply it to your response:\n\n{{input}}]'
export type Settings = { template: string; role: 'system' | 'user'; clearInput: boolean }
export const DEFAULT_SETTINGS: Settings = { template: DEFAULT_TEMPLATE, role: 'system', clearInput: true }

export function normalizeSettings(value: unknown): Settings {
  const v = value && typeof value === 'object' ? value as Partial<Settings> : {}
  return {
    template: typeof v.template === 'string' ? v.template : DEFAULT_TEMPLATE,
    role: v.role === 'user' ? 'user' : 'system',
    clearInput: v.clearInput !== false,
  }
}

export function renderTemplate(template: string, input: string): string {
  if (!template.trim()) throw new Error('Prompt Template cannot be empty.')
  return template.replaceAll('{{input}}', input)
}

export type Pending = { userId: string; chatId: string; sessionId: string; token: string; input: string; settings: Settings; expiresAt: number }
export class PendingGuides {
  private entries = new Map<string, Pending>()
  private key(userId: string, chatId: string) { return `${userId}\u0000${chatId}` }
  arm(entry: Pending, now = Date.now()) {
    const key = this.key(entry.userId, entry.chatId)
    const previous = this.entries.get(key)
    if (previous && previous.expiresAt > now) throw new Error('A guide is already pending for this chat.')
    this.entries.set(key, entry)
  }
  cancel(userId: string, chatId: string, token: string) {
    const key = this.key(userId, chatId)
    if (this.entries.get(key)?.token === token) this.entries.delete(key)
  }
  consume(userId: string, chatId: string, sessionId: string | undefined, generationType: string, dryRun = false, now = Date.now()) {
    const key = this.key(userId, chatId)
    const item = this.entries.get(key)
    if (!item) return undefined
    if (item.expiresAt <= now) { this.entries.delete(key); return undefined }
    if (generationType !== 'normal' || dryRun || !sessionId || sessionId !== item.sessionId) return undefined
    this.entries.delete(key)
    return item
  }
}

export function inject<T extends { role: string; content: unknown }>(messages: readonly T[], pending: Pick<Pending, 'input' | 'settings'>) {
  const added = { role: pending.settings.role, content: renderTemplate(pending.settings.template, pending.input) }
  return { messages: [added as T, ...messages], breakdown: [{ messageIndex: 0, name: 'Scene Direction' }] }
}
