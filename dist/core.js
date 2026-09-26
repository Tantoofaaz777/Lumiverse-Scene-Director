const DEFAULT_TEMPLATE = "[Treat the following instruction as explicit scene direction and apply it to your response:\n\n{{input}}]";
const DEFAULT_SETTINGS = { version: 2, template: DEFAULT_TEMPLATE, clearInput: true, integrateComposer: false };
function normalizeSettings(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    version: 2,
    template: typeof v.template === "string" ? v.template : DEFAULT_TEMPLATE,
    clearInput: v.clearInput !== false,
    integrateComposer: v.integrateComposer === true
  };
}
function renderTemplate(template, input) {
  if (!template.trim()) throw new Error("Prompt Template cannot be empty.");
  return template.replaceAll("{{input}}", () => input);
}
const START_TIMEOUT_MS = 15e3;
class PendingGuides {
  entries = /* @__PURE__ */ new Map();
  key(userId, chatId) {
    return `${userId}\0${chatId}`;
  }
  arm(entry) {
    const key = this.key(entry.userId, entry.chatId);
    const previous = this.entries.get(key);
    if (previous) throw new Error("A guide is already pending for this chat.");
    this.entries.set(key, entry);
  }
  get(userId, chatId) {
    return this.entries.get(this.key(userId, chatId));
  }
  // Reserve before any asynchronous work. Identity checks make cancellation final,
  // even when a storage read resolves after cancellation or a newer reservation.
  activate(entry, settings, now = Date.now()) {
    if (this.get(entry.userId, entry.chatId) !== entry || entry.expiresAt <= now) throw new Error("The guide was cancelled or timed out. Try again.");
    entry.settings = settings;
  }
  start(userId, chatId, sessionId, generationType, generationId, now = Date.now()) {
    const entry = this.get(userId, chatId);
    if (!entry?.settings || entry.generationId || entry.expiresAt <= now || !sessionId || sessionId !== entry.sessionId || generationType !== "normal") return void 0;
    entry.generationId = generationId;
    return entry;
  }
  cancel(userId, chatId, token, sessionId) {
    const key = this.key(userId, chatId);
    const entry = this.entries.get(key);
    if (entry?.token !== token || sessionId && entry.sessionId !== sessionId) return void 0;
    this.entries.delete(key);
    return entry;
  }
  consume(userId, chatId, sessionId, generationType, dryRun = false) {
    const key = this.key(userId, chatId);
    const item = this.entries.get(key);
    if (!item) return void 0;
    if (generationType !== "normal" || dryRun || !sessionId || sessionId !== item.sessionId) return void 0;
    if (item.consumed) return void 0;
    if (!item.generationId || !item.settings) throw new Error("Scene Direction did not observe the generation starting. Please retry.");
    item.consumed = true;
    return item;
  }
}
function inject(messages, pending) {
  let insertionIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].__isChatHistory === true) {
      insertionIndex = i + 1;
      break;
    }
  }
  if (insertionIndex < 0) {
    if (messages.length === 0) insertionIndex = 0;
    else throw new Error("Scene Direction could not locate chat history in the assembled prompt. Include a native Chat History block with at least one visible chat turn in your preset.");
  }
  const added = { role: "user", content: renderTemplate(pending.settings.template, pending.input) };
  return {
    messages: [...messages.slice(0, insertionIndex), added, ...messages.slice(insertionIndex)],
    breakdown: [{ messageIndex: insertionIndex, name: "Scene Direction" }]
  };
}
export {
  DEFAULT_SETTINGS,
  DEFAULT_TEMPLATE,
  PendingGuides,
  START_TIMEOUT_MS,
  inject,
  normalizeSettings,
  renderTemplate
};
