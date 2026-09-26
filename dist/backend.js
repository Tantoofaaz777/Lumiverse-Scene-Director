// src/core.ts
var DEFAULT_TEMPLATE = "[Treat the following instruction as explicit scene direction and apply it to your response:\n\n{{input}}]";
var DEFAULT_SETTINGS = { version: 2, template: DEFAULT_TEMPLATE, clearInput: true, integrateComposer: false };
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
var START_TIMEOUT_MS = 15e3;
var PendingGuides = class {
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
  activate(entry, settings2, now = Date.now()) {
    if (this.get(entry.userId, entry.chatId) !== entry || entry.expiresAt <= now) throw new Error("The guide was cancelled or timed out. Try again.");
    entry.settings = settings2;
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
};
function inject(messages, pending2) {
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
  const added = { role: "user", content: renderTemplate(pending2.settings.template, pending2.input) };
  return {
    messages: [...messages.slice(0, insertionIndex), added, ...messages.slice(insertionIndex)],
    breakdown: [{ messageIndex: insertionIndex, name: "Scene Direction" }]
  };
}

// src/backend.ts
var pending = new PendingGuides();
var timers = /* @__PURE__ */ new Map();
var settingsPath = "settings.json";
var receipts = /* @__PURE__ */ new Map();
var receiptKey = (userId, sessionId, chatId, token) => JSON.stringify([userId, sessionId, chatId, token]);
function pruneReceipts() {
  for (const [key, receipt] of receipts) if (Date.now() - receipt.at > 864e5) receipts.delete(key);
  while (receipts.size > 256) receipts.delete(receipts.keys().next().value);
}
async function settings(userId) {
  return normalizeSettings(await spindle.userStorage.getJson(settingsPath, { fallback: DEFAULT_SETTINGS, userId }));
}
var routed = spindle;
function clearTimer(entry) {
  clearTimeout(timers.get(entry));
  timers.delete(entry);
}
function notify(entry, type, message) {
  routed.sendToFrontend({ type, token: entry.token, chatId: entry.chatId, message }, entry.userId, { frontendSessionId: entry.sessionId });
}
function finish(entry, message) {
  if (pending.get(entry.userId, entry.chatId) !== entry) return;
  pending.cancel(entry.userId, entry.chatId, entry.token);
  clearTimer(entry);
  receipts.set(receiptKey(entry.userId, entry.sessionId, entry.chatId, entry.token), {
    type: message ? "guide:failed" : "guide:finished",
    message,
    at: Date.now()
  });
  pruneReceipts();
  notify(entry, message ? "guide:failed" : "guide:finished", message);
}
var subscriptions = [];
function subscribeGenerationEvents() {
  if (subscriptions.length) return;
  subscriptions = [
    spindle.on("GENERATION_STARTED", (raw, userId) => {
      const event = raw;
      if (!userId || !event.chatId || !event.generationId) return;
      const entry = pending.start(userId, event.chatId, event.frontendSessionId, event.generationType ?? "", event.generationId);
      if (entry) {
        clearTimer(entry);
        notify(entry, "guide:started");
      }
    }),
    ...["GENERATION_ENDED", "GENERATION_STOPPED"].map((type) => spindle.on(type, (raw, userId) => {
      const event = raw;
      if (!userId || !event.chatId) return;
      const entry = pending.get(userId, event.chatId);
      if (!entry?.generationId || entry.generationId !== event.generationId) return;
      const error = event.error || event.errorMessage || (type === "GENERATION_STOPPED" ? "The guided generation was stopped." : void 0);
      finish(entry, error || (!entry.consumed ? "The generation ended without applying the scene direction." : void 0));
    }))
  ];
}
routed.onFrontendMessage(async (raw, userId, frontendSessionId) => {
  if (!raw || typeof raw !== "object") return;
  const msg = raw;
  if (typeof msg.type !== "string") return;
  const reply = (type, data = {}) => routed.sendToFrontend({ type, requestId: msg.requestId, ...data }, userId, { frontendSessionId });
  let reservation;
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
    if (!frontendSessionId) throw new Error("This Lumiverse version cannot bind a guide to the active browser session.");
    if (typeof msg.chatId !== "string" || !msg.chatId || typeof msg.token !== "string" || !msg.token) throw new Error("Invalid guide request.");
    if (msg.type === "guide:status") {
      pruneReceipts();
      const identity = { chatId: msg.chatId, token: msg.token };
      const receipt = receipts.get(receiptKey(userId, frontendSessionId, msg.chatId, msg.token));
      if (receipt) {
        reply(receipt.type, { ...identity, message: receipt.message });
        return;
      }
      const entry2 = pending.get(userId, msg.chatId);
      if (entry2?.sessionId === frontendSessionId && entry2.token === msg.token) {
        reply(entry2.consumed ? "guide:consumed" : entry2.generationId ? "guide:started" : "guide:pending", identity);
      } else {
        reply("guide:failed", { ...identity, message: "The guide state is no longer available. Check the chat history before retrying." });
      }
      return;
    }
    if (msg.type === "guide:cancel") {
      const entry2 = pending.get(userId, msg.chatId);
      if (entry2 && !entry2.generationId) {
        const removed = pending.cancel(userId, msg.chatId, msg.token, frontendSessionId);
        if (removed) clearTimer(removed);
      }
      reply("guide:cancelled");
      return;
    }
    if (msg.type !== "guide:arm") return;
    if (typeof msg.input !== "string" || !msg.input.trim()) throw new Error("Enter a scene direction first.");
    reservation = { userId, chatId: msg.chatId, sessionId: frontendSessionId, token: msg.token, input: msg.input, expiresAt: Date.now() + START_TIMEOUT_MS };
    pending.arm(reservation);
    const entry = reservation;
    timers.set(entry, setTimeout(() => finish(entry, "The native generation did not start. Your direction was not applied; try again."), START_TIMEOUT_MS));
    const granted = await spindle.permissions.getGranted();
    if (!granted.includes("generation") || !granted.includes("interceptor")) throw new Error("Enable the generation and interceptor permissions for Scene Direction in Extensions.");
    const capabilities = spindle.host.capabilities;
    if (!capabilities["frontend-session-origin-v1"] || !capabilities["required-interceptors-v1"]) throw new Error("Update Lumiverse: Scene Direction requires document routing and required interceptors.");
    const config = await settings(userId);
    renderTemplate(config.template, msg.input);
    pending.activate(entry, config);
    subscribeGenerationEvents();
    reply("guide:armed");
  } catch (error) {
    if (reservation && pending.get(userId, reservation.chatId) === reservation) {
      pending.cancel(userId, reservation.chatId, reservation.token);
      clearTimer(reservation);
    }
    reply("error", { message: error instanceof Error ? error.message : "Scene Direction failed." });
  }
});
spindle.registerInterceptor(async (messages, context) => {
  const ctx = context;
  const guide = ctx.userId && ctx.chatId ? pending.consume(ctx.userId, ctx.chatId, ctx.frontendSessionId, ctx.generationType ?? "", ctx.dryRun) : void 0;
  if (!guide) return messages;
  const result = inject(messages, guide);
  notify(guide, "guide:consumed");
  return result;
}, { priority: 100, required: true });
