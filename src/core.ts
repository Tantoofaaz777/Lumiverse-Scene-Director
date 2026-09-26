export const DEFAULT_TEMPLATE = '[Treat the following instruction as explicit scene direction and apply it to your response:\n\n{{input}}]'
export type Settings = { version: 2; template: string; role: 'system' | 'user'; clearInput: boolean }
export const DEFAULT_SETTINGS: Settings = { version: 2, template: DEFAULT_TEMPLATE, role: 'user', clearInput: true }

export function normalizeSettings(value: unknown): Settings {
  const v = value && typeof value === 'object' ? value as Partial<Settings> : {}
  return {
    version: 2,
    template: typeof v.template === 'string' ? v.template : DEFAULT_TEMPLATE,
    // Legacy settings used System by default. Migrate the existing installation
    // to a temporary user turn, while allowing an explicit System choice later.
    role: v.version === 2 && v.role === 'system' ? 'system' : 'user',
    clearInput: v.clearInput !== false,
  }
}

export function renderTemplate(template: string, input: string): string {
  if (!template.trim()) throw new Error('Prompt Template cannot be empty.')
  return template.replaceAll('{{input}}', () => input)
}

export const START_TIMEOUT_MS = 15000
export type Pending = { userId: string; chatId: string; sessionId: string; token: string; input: string; settings?: Settings; expiresAt: number; generationId?: string; consumed?: boolean }
export class PendingGuides {
  private entries = new Map<string, Pending>()
  private key(userId: string, chatId: string) { return `${userId}\u0000${chatId}` }
  arm(entry: Pending, now = Date.now()) {
    const key = this.key(entry.userId, entry.chatId)
    const previous = this.entries.get(key)
    if (previous) throw new Error('A guide is already pending for this chat.')
    this.entries.set(key, entry)
  }
  get(userId: string, chatId: string) { return this.entries.get(this.key(userId, chatId)) }
  // Reserve before any asynchronous work. Identity checks make cancellation final,
  // even when a storage read resolves after cancellation or a newer reservation.
  activate(entry: Pending, settings: Settings, now = Date.now()) {
    if (this.get(entry.userId, entry.chatId) !== entry || entry.expiresAt <= now) throw new Error('The guide was cancelled or timed out. Try again.')
    entry.settings = settings
  }
  start(userId: string, chatId: string, sessionId: string | undefined, generationType: string, generationId: string, now = Date.now()) {
    const entry = this.get(userId, chatId)
    if (!entry?.settings || entry.generationId || entry.expiresAt <= now || !sessionId || sessionId !== entry.sessionId || generationType !== 'normal') return undefined
    entry.generationId = generationId
    return entry
  }
  cancel(userId: string, chatId: string, token: string, sessionId?: string) {
    const key = this.key(userId, chatId)
    const entry = this.entries.get(key)
    if (entry?.token !== token || (sessionId && entry.sessionId !== sessionId)) return undefined
    this.entries.delete(key)
    return entry
  }
  consume(userId: string, chatId: string, sessionId: string | undefined, generationType: string, dryRun = false, now = Date.now()) {
    const key = this.key(userId, chatId)
    const item = this.entries.get(key)
    if (!item) return undefined
    if (generationType !== 'normal' || dryRun || !sessionId || sessionId !== item.sessionId) return undefined
    if (item.consumed) return undefined
    if (!item.generationId || !item.settings) throw new Error('Scene Direction did not observe the generation starting. Please retry.')
    // Once the native generation has started, slow assembly must not expire it.
    item.consumed = true
    return item as Pending & { settings: Settings }
  }
}

export function inject<T extends { role: string; content: unknown; __isChatHistory?: boolean }>(messages: readonly T[], pending: { input: string; settings: Settings }) {
  let insertionIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].__isChatHistory === true) { insertionIndex = i + 1; break }
  }
  // With no messages there is only one possible position. Otherwise, an absent
  // source marker is ambiguous (empty/excluded history or a flattened preset).
  // Never guess based on role: examples and post-history instructions can be User.
  if (insertionIndex < 0) {
    if (messages.length === 0) insertionIndex = 0
    else throw new Error('Scene Direction could not locate chat history in the assembled prompt. Include a native Chat History block with at least one visible chat turn in your preset.')
  }
  const added = { role: pending.settings.role, content: renderTemplate(pending.settings.template, pending.input) }
  // This is a synthetic prompt message, not a stored source turn: do not forge
  // sourceMessageId or __isChatHistory. Report it as its own breakdown entry.
  return {
    messages: [...messages.slice(0, insertionIndex), added as T, ...messages.slice(insertionIndex)],
    breakdown: [{ messageIndex: insertionIndex, name: 'Scene Direction' }],
  }
}
