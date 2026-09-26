const DEFAULT_TEMPLATE = "[Treat the following instruction as explicit scene direction and apply it to your response:\n\n{{input}}]";
const DEFAULT_SETTINGS = { template: DEFAULT_TEMPLATE, role: "system", clearInput: true };
function normalizeSettings(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    template: typeof v.template === "string" ? v.template : DEFAULT_TEMPLATE,
    role: v.role === "user" ? "user" : "system",
    clearInput: v.clearInput !== false
  };
}
function renderTemplate(template, input) {
  if (!template.trim()) throw new Error("Prompt Template cannot be empty.");
  return template.replaceAll("{{input}}", input);
}
class PendingGuides {
  entries = /* @__PURE__ */ new Map();
  key(userId, chatId) {
    return `${userId}\0${chatId}`;
  }
  arm(entry, now = Date.now()) {
    const key = this.key(entry.userId, entry.chatId);
    const previous = this.entries.get(key);
    if (previous && previous.expiresAt > now) throw new Error("A guide is already pending for this chat.");
    this.entries.set(key, entry);
  }
  cancel(userId, chatId, token) {
    const key = this.key(userId, chatId);
    if (this.entries.get(key)?.token === token) this.entries.delete(key);
  }
  consume(userId, chatId, sessionId, generationType, dryRun = false, now = Date.now()) {
    const key = this.key(userId, chatId);
    const item = this.entries.get(key);
    if (!item) return void 0;
    if (item.expiresAt <= now) {
      this.entries.delete(key);
      return void 0;
    }
    if (generationType !== "normal" || dryRun || !sessionId || sessionId !== item.sessionId) return void 0;
    this.entries.delete(key);
    return item;
  }
}
function inject(messages, pending) {
  const added = { role: pending.settings.role, content: renderTemplate(pending.settings.template, pending.input) };
  return { messages: [added, ...messages], breakdown: [{ messageIndex: 0, name: "Scene Direction" }] };
}
export {
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATE,
  PendingGuides,
  inject,
  normalizeSettings,
  renderTemplate
};
