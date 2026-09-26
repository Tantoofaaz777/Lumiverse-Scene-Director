// src/core.ts
var DEFAULT_TEMPLATE = "[Treat the following instruction as explicit scene direction and apply it to your response:\n\n{{input}}]";
var DEFAULT_SETTINGS = { template: DEFAULT_TEMPLATE, role: "system", clearInput: true };
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
var PendingGuides = class {
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
};
function inject(messages, pending2) {
  const added = { role: pending2.settings.role, content: renderTemplate(pending2.settings.template, pending2.input) };
  return { messages: [added, ...messages], breakdown: [{ messageIndex: 0, name: "Scene Direction" }] };
}

// src/backend.ts
var pending = new PendingGuides();
var settingsPath = "settings.json";
async function settings(userId) {
  return normalizeSettings(await spindle.userStorage.getJson(settingsPath, { fallback: DEFAULT_SETTINGS, userId }));
}
var routed = spindle;
routed.onFrontendMessage(async (raw, userId, frontendSessionId) => {
  const msg = raw;
  if (!msg || typeof msg.type !== "string") return;
  const reply = (type, data = {}) => routed.sendToFrontend({ type, requestId: msg.requestId, ...data }, userId, { frontendSessionId });
  try {
    if (msg.type === "settings:get") {
      reply("settings:result", { settings: await settings(userId) });
      return;
    }
    if (msg.type === "settings:save") {
      const next = normalizeSettings(msg.settings);
      await spindle.userStorage.setJson(settingsPath, next, { userId });
      reply("settings:result", { settings: next });
      return;
    }
    if (msg.type === "guide:cancel" && msg.chatId && msg.token) {
      pending.cancel(userId, msg.chatId, msg.token);
      reply("guide:cancelled");
      return;
    }
    if (msg.type !== "guide:arm") return;
    if (!frontendSessionId) throw new Error("This Lumiverse version cannot bind a guide to the active browser session.");
    if (!msg.chatId || !msg.token || typeof msg.input !== "string" || !msg.input.trim()) throw new Error("Enter a scene direction first.");
    const config = await settings(userId);
    renderTemplate(config.template, msg.input);
    pending.arm({ userId, chatId: msg.chatId, sessionId: frontendSessionId, token: msg.token, input: msg.input, settings: config, expiresAt: Date.now() + 15e3 });
    reply("guide:armed");
  } catch (error) {
    reply("error", { message: error instanceof Error ? error.message : "Scene Direction failed." });
  }
});
spindle.registerInterceptor(async (messages, context) => {
  const ctx = context;
  const guide = ctx.userId && ctx.chatId ? pending.consume(ctx.userId, ctx.chatId, ctx.frontendSessionId, ctx.generationType ?? "", ctx.dryRun) : void 0;
  return guide ? inject(messages, guide) : messages;
}, { priority: 100, required: true });
