// src/core.ts
var DEFAULT_TEMPLATE = "[Treat the following instruction as explicit scene direction and apply it to your response:\n\n{{input}}]";
var DEFAULT_SETTINGS = { version: 2, template: DEFAULT_TEMPLATE, role: "user", clearInput: true };
function normalizeSettings(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    version: 2,
    template: typeof v.template === "string" ? v.template : DEFAULT_TEMPLATE,
    // Ignore saved role choices from earlier versions: guides are user turns.
    role: "user",
    clearInput: v.clearInput !== false
  };
}

// src/composer.ts
var INPUT = 'textarea[name="chat-message"]';
function composer() {
  const input = document.querySelector(INPUT);
  if (!input) throw new Error("Lumiverse chat input was not found.");
  const button = input.parentElement?.nextElementSibling?.querySelector("button[aria-label]");
  const send = button?.querySelector("svg.lucide-send") && !button.disabled ? button : void 0;
  return { input, send };
}
function readDraft() {
  return composer().input.value;
}
function setDraft(value) {
  const { input } = composer();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Cannot update the native input.");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function freshReplyButton(input, draftLabel) {
  const current = composer();
  if (current.input !== input || !input.isConnected || input.value !== "" || !current.send) throw new Error("The fresh-reply control is unavailable or the chat draft changed.");
  const label = current.send.getAttribute("aria-label");
  if (!draftLabel || !label || label === draftLabel) throw new Error("Remove pending attachments or selected send actions before using Guide Response.");
  return current.send;
}
async function waitForEmptyComposer(input, draftLabel) {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  return freshReplyButton(input, draftLabel);
}

// src/toolbar.ts
function mountGuideToolbar(onClick, onSimpleSend, state) {
  const toolbar = document.createElement("div");
  toolbar.id = "sd-guide-toolbar";
  const style = document.createElement("style");
  style.textContent = `
    #sd-guide-toolbar {
      display: flex; align-items: center; gap: 4px; padding: 4px 8px;
      flex-shrink: 0; box-sizing: border-box; border-top: 1px solid var(--lumiverse-border);
    }
    #sd-guide-toolbar button {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; padding: 0; border-radius: 5px;
      border: 1px solid transparent; background: transparent;
      color: var(--lumiverse-text-dim); cursor: pointer;
      transition: background .13s, color .13s, border-color .13s;
    }
    #sd-guide-toolbar button:hover:not(:disabled) {
      background: var(--lumiverse-fill); color: var(--lumiverse-text);
    }
    #sd-guide-toolbar button:focus-visible {
      outline: 2px solid var(--lumiverse-accent); outline-offset: 2px;
    }
    #sd-guide-toolbar button:disabled { cursor: default; opacity: .45; }
    #sd-guide-toolbar button[aria-busy="true"] { color: var(--lumiverse-accent); opacity: .75; }
  `;
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Guide Response");
  button.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m4 11 16-4-1-4L3 7l1 4Z"/><path d="m8 6 3 4m3-6 3 4M4 11v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7M4 14h16"/></svg>';
  button.addEventListener("click", onClick);
  const simple = document.createElement("button");
  simple.type = "button";
  simple.setAttribute("aria-label", "Simple Send");
  simple.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13"/><path d="M19 2v6m-3-3h6"/></svg>';
  simple.addEventListener("click", onSimpleSend);
  toolbar.append(style, button, simple);
  let disposed = false;
  function refresh() {
    if (disposed) return;
    let current;
    try {
      current = composer();
    } catch {
      toolbar.remove();
      return;
    }
    const area = current.input.closest('[data-component="InputArea"]');
    const row = current.input.parentElement?.parentElement;
    if (!area || !row || row.parentElement !== area) {
      toolbar.remove();
      return;
    }
    if (toolbar.parentElement !== area || toolbar.nextElementSibling !== row) area.insertBefore(toolbar, row);
    const { ready, busy } = state();
    const disabled = !ready || busy || !current.send || !current.input.value.trim();
    if (button.disabled !== disabled) button.disabled = disabled;
    const busyLabel = String(busy);
    if (button.getAttribute("aria-busy") !== busyLabel) button.setAttribute("aria-busy", busyLabel);
    const title = !ready ? "Scene Direction settings are not ready." : busy ? "Scene Direction action in progress\u2026" : !current.send ? "Wait for the current generation to finish." : !current.input.value.trim() ? "Type a scene direction first." : "Guide Response";
    if (button.title !== title) button.title = title;
    const simpleDisabled = busy || !current.send || !current.input.value.trim();
    if (simple.disabled !== simpleDisabled) simple.disabled = simpleDisabled;
    const simpleTitle = busy ? "Scene Direction action in progress\u2026" : !current.send ? "Wait for the current generation to finish." : !current.input.value.trim() ? "Type a message first." : "Simple Send \u2014 save your message without generating a reply";
    if (simple.title !== simpleTitle) simple.title = simpleTitle;
  }
  function onInput(event) {
    if (event.target instanceof HTMLTextAreaElement && event.target.name === "chat-message") refresh();
  }
  const observer = new MutationObserver(refresh);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "disabled", "aria-label"] });
  document.addEventListener("input", onInput, true);
  refresh();
  return {
    refresh,
    destroy() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      document.removeEventListener("input", onInput, true);
      button.removeEventListener("click", onClick);
      simple.removeEventListener("click", onSimpleSend);
      toolbar.remove();
    }
  };
}

// src/simple-send.ts
async function simpleSend(ctx, signal) {
  const chatId = ctx.getActiveChat().chatId;
  if (!chatId) throw new Error("Open a chat before sending a message.");
  const { input } = composer();
  const original = input.value;
  if (!original.trim()) throw new Error("Type a message first.");
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (signal.aborted) return;
  const current = composer();
  if (ctx.getActiveChat().chatId !== chatId || current.input !== input || !input.isConnected || input.value !== original) {
    throw new Error("The active chat or message changed. Send again from the current input.");
  }
  if (!current.send) throw new Error("Wait for the current generation to finish.");
  await new Promise((resolve, reject) => {
    let unsubscribe = () => {
    };
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish();
    try {
      unsubscribe = ctx.events.on("MESSAGE_SENT", (raw) => {
        const event = raw;
        if (event?.chatId === chatId && event.message?.is_user === true) finish();
      });
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => finish(new Error("Could not confirm Simple Send. Check the chat history before retrying.")), 15e3);
      current.send.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ctrlKey: true,
        metaKey: true
      }));
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Simple Send failed."));
    }
  });
}

// src/frontend.ts
function setup(ctx) {
  const root = ctx.ui.mount("settings_extensions");
  const style = document.createElement("style");
  style.textContent = `
    .sd-settings { color: var(--lumiverse-text); font: inherit; }
    .sd-title { margin: 0 0 4px; font-size: 16px; font-weight: 650; }
    .sd-intro, .sd-hint { color: var(--lumiverse-text-dim); font-size: 13px; line-height: 1.45; }
    .sd-intro { margin: 0 0 16px; }
    .sd-row { display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 14px 0; border-top: 1px solid var(--lumiverse-border); }
    .sd-row--stack { display: block; }
    .sd-label { display: block; font-size: 14px; font-weight: 550; }
    .sd-hint { margin: 4px 0 0; }
    .sd-control { display: flex; align-items: center; justify-content: flex-end; flex: 0 0 auto; }
    .sd-template { margin-top: 12px; width: 100%; min-width: 0; }
    .sd-template textarea { box-sizing: border-box; width: 100%; max-width: 100%; }
    .sd-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      flex-wrap: wrap; padding-top: 14px; border-top: 1px solid var(--lumiverse-border); }
    .sd-reset { appearance: none; padding: 7px 12px; border-radius: 8px;
      border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill-subtle);
      color: var(--lumiverse-text); font: inherit; font-size: 13px; cursor: pointer; }
    .sd-reset:hover { background: var(--lumiverse-fill-hover); border-color: var(--lumiverse-border-hover); }
    .sd-reset:focus-visible { outline: 2px solid var(--lumiverse-accent); outline-offset: 2px; }
    .sd-status { margin: 0; color: var(--lumiverse-text-dim); font-size: 12px; }
    @media (max-width: 520px) { .sd-row { gap: 10px; } }
  `;
  const panel = document.createElement("section");
  panel.className = "sd-settings";
  const heading = document.createElement("h2");
  heading.className = "sd-title";
  heading.textContent = "Scene Direction";
  const intro = document.createElement("p");
  intro.className = "sd-intro";
  intro.textContent = "Add a temporary direction after the last chat turn for the next reply.";
  function label(title, hint) {
    const wrap = document.createElement("div");
    const name = document.createElement("span");
    name.className = "sd-label";
    name.textContent = title;
    const description = document.createElement("p");
    description.className = "sd-hint";
    description.textContent = hint;
    wrap.append(name, description);
    return wrap;
  }
  const templateRow = document.createElement("div");
  templateRow.className = "sd-row sd-row--stack";
  const templateSlot = document.createElement("div");
  templateSlot.className = "sd-template";
  templateRow.append(label("Prompt Template", "Use {{input}} to place the draft in the one-shot instruction."), templateSlot);
  const clearRow = document.createElement("div");
  clearRow.className = "sd-row";
  const clearSlot = document.createElement("div");
  clearSlot.className = "sd-control";
  clearRow.append(label("Clear Input After Guide", "Remove the direction from the chat draft after use."), clearSlot);
  const actions = document.createElement("div");
  actions.className = "sd-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "sd-reset";
  reset.textContent = "Reset Template";
  const status = document.createElement("p");
  status.className = "sd-status";
  status.setAttribute("role", "status");
  actions.append(reset, status);
  panel.append(heading, intro, templateRow, clearRow, actions);
  root.append(style, panel);
  const template = ctx.components.mountTextArea(templateSlot, { value: DEFAULT_TEMPLATE, rows: 6, ariaLabel: "Prompt Template", disabled: true, onChange: () => scheduleSave() });
  const clear = ctx.components.mountSwitch(clearSlot, { checked: true, ariaLabel: "Clear Input After Guide", disabled: true, onChange: () => scheduleSave() });
  let current = DEFAULT_SETTINGS;
  let disposed = false;
  let busy = false;
  let simpleController;
  let settingsReady = false;
  let saveTimer;
  let saveTail = Promise.resolve();
  let active;
  const waiting = /* @__PURE__ */ new Map();
  function request(type, data = {}) {
    if (disposed) return Promise.reject(new Error("Extension unloaded."));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error("The extension backend did not respond."));
      }, 5e3);
      waiting.set(requestId, { resolve, reject, timer });
      try {
        ctx.sendToBackend({ type, requestId, ...data });
      } catch (error) {
        clearTimeout(timer);
        waiting.delete(requestId);
        reject(error);
      }
    });
  }
  function restore(guide2) {
    if (disposed) return;
    try {
      if (ctx.getActiveChat().chatId === guide2.chatId && composer().input === guide2.input && readDraft() === "") setDraft(guide2.original);
    } catch {
    }
  }
  function release(guide2) {
    clearTimeout(guide2.watchdog);
    if (active === guide2) {
      active = void 0;
      busy = false;
    }
    toolbar.refresh();
  }
  function fail(message) {
    status.textContent = message;
    window.alert(message);
  }
  const unsubscribe = ctx.onBackendMessage((raw) => {
    const msg = raw;
    if (!msg) return;
    if (active && msg.token === active.token && msg.chatId === active.chatId) {
      const guide2 = active;
      if (msg.type === "guide:started") {
        guide2.started = true;
        clearTimeout(guide2.watchdog);
        status.textContent = "Preparing the guided response\u2026";
        if (!guide2.clearInput) restore(guide2);
      } else if (msg.type === "guide:consumed") {
        guide2.started = true;
        clearTimeout(guide2.watchdog);
        if (!guide2.clearInput) restore(guide2);
        status.textContent = "Scene direction applied.";
      } else if (msg.type === "guide:failed") {
        restore(guide2);
        release(guide2);
        fail(msg.message || "The scene direction was not applied.");
      } else if (msg.type === "guide:finished") {
        status.textContent = "Guided response completed.";
        release(guide2);
      }
    }
    const waiter = msg.requestId && waiting.get(msg.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiting.delete(msg.requestId);
    if (msg.type === "error") waiter.reject(new Error(msg.message || "Scene Direction failed."));
    else waiter.resolve(msg);
  });
  function snapshot() {
    return normalizeSettings({ version: 2, template: template.getValue(), clearInput: clear.getValue() });
  }
  function show(value) {
    current = value;
    template.update({ value: value.template });
    clear.update({ checked: value.clearInput });
  }
  function persist(override) {
    clearTimeout(saveTimer);
    saveTimer = void 0;
    const next = override ?? snapshot();
    status.textContent = "Saving\u2026";
    saveTail = saveTail.catch(() => {
    }).then(async () => {
      await request("settings:save", { settings: next });
      current = next;
      if (!disposed) status.textContent = "Saved.";
    }).catch((error) => {
      if (!disposed) status.textContent = error.message;
      throw error;
    });
    return saveTail;
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    status.textContent = "Unsaved changes";
    saveTimer = setTimeout(() => {
      void persist().catch(() => {
      });
    }, 500);
  }
  reset.disabled = true;
  reset.addEventListener("click", () => {
    const next = { ...snapshot(), template: DEFAULT_TEMPLATE };
    template.update({ value: DEFAULT_TEMPLATE });
    void persist(next).catch(() => {
    });
  });
  const ready = request("settings:get").then((result) => {
    if (disposed) return;
    show(normalizeSettings(result.settings));
    template.update({ disabled: false });
    clear.update({ disabled: false });
    reset.disabled = false;
    settingsReady = true;
    toolbar.refresh();
  });
  void ready.catch((error) => {
    if (!disposed) status.textContent = error.message;
  });
  const toolbar = mountGuideToolbar(() => {
    void guide();
  }, () => {
    void sendOnly();
  }, () => ({ ready: settingsReady, busy }));
  async function sendOnly() {
    if (busy || disposed) return;
    busy = true;
    const controller = new AbortController();
    simpleController = controller;
    toolbar.refresh();
    try {
      status.textContent = "Sending your message\u2026";
      await simpleSend(ctx, controller.signal);
      if (!disposed && status.textContent === "Sending your message\u2026") status.textContent = "";
    } catch (error) {
      if (!disposed) fail(error instanceof Error ? error.message : "Simple Send failed.");
    } finally {
      simpleController = void 0;
      busy = false;
      toolbar.refresh();
    }
  }
  async function guide() {
    if (busy || disposed) return;
    busy = true;
    toolbar.refresh();
    let attempt;
    try {
      const chatId = ctx.getActiveChat().chatId;
      if (!chatId) throw new Error("Open a chat before guiding a response.");
      await ready;
      if (saveTimer) await persist();
      else await saveTail;
      if (disposed || ctx.getActiveChat().chatId !== chatId) throw new Error("The active chat changed.");
      const { input, send } = composer();
      if (!send) throw new Error("The native fresh-reply button is unavailable. Wait for the current generation to finish.");
      const original = input.value;
      if (!original.trim()) throw new Error("Enter a scene direction first.");
      if (!current.template.trim()) throw new Error("Prompt Template cannot be empty.");
      const draftLabel = send.getAttribute("aria-label") || "";
      attempt = { token: crypto.randomUUID(), chatId, original, input, clearInput: current.clearInput, started: false };
      active = attempt;
      setDraft("");
      await waitForEmptyComposer(input, draftLabel);
      if (disposed || ctx.getActiveChat().chatId !== chatId) throw new Error("The active chat changed.");
      await request("guide:arm", { chatId, token: attempt.token, input: original });
      if (disposed || active !== attempt || ctx.getActiveChat().chatId !== chatId) throw new Error("The guide was cancelled or the active chat changed.");
      const nativeSend = freshReplyButton(input, draftLabel);
      const selected = attempt;
      selected.watchdog = setTimeout(() => {
        if (active !== selected || selected.started) return;
        void request("guide:cancel", { chatId, token: selected.token }).catch(() => {
        });
        restore(selected);
        release(selected);
        fail("The native generation did not confirm its start. Check the connection and try again.");
      }, 16e3);
      nativeSend.click();
      status.textContent = "Waiting for the native generation\u2026";
    } catch (error) {
      if (attempt && !attempt.started) {
        if (!disposed) void request("guide:cancel", { chatId: attempt.chatId, token: attempt.token }).catch(() => {
        });
        restore(attempt);
        release(attempt);
      }
      if (!disposed) fail(error instanceof Error ? error.message : "Guide Response failed.");
    } finally {
      if (!active) busy = false;
      toolbar.refresh();
    }
  }
  return () => {
    if (disposed) return;
    if (active) {
      if (!active.started) {
        try {
          ctx.sendToBackend({ type: "guide:cancel", chatId: active.chatId, token: active.token });
        } catch {
        }
        restore(active);
      }
      clearTimeout(active.watchdog);
    }
    disposed = true;
    simpleController?.abort();
    clearTimeout(saveTimer);
    toolbar.destroy();
    template.destroy();
    clear.destroy();
    root.replaceChildren();
    unsubscribe();
    for (const waiter of waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Extension unloaded."));
    }
    waiting.clear();
  };
}
export {
  setup
};
