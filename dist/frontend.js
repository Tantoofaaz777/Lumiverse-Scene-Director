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
async function waitForEmptyComposer() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const { input, send } = composer();
  if (input.value !== "" || !send) throw new Error("The fresh-reply control is unavailable or the input did not clear.");
  return send;
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
    .sd-control { min-width: 130px; flex: 0 0 auto; }
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
    @media (max-width: 520px) { .sd-row { gap: 10px; } .sd-control { min-width: 108px; } }
  `;
  const panel = document.createElement("section");
  panel.className = "sd-settings";
  const heading = document.createElement("h2");
  heading.className = "sd-title";
  heading.textContent = "Scene Direction";
  const intro = document.createElement("p");
  intro.className = "sd-intro";
  intro.textContent = "Guide the next reply without adding a user message.";
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
  const roleRow = document.createElement("div");
  roleRow.className = "sd-row";
  const roleSlot = document.createElement("div");
  roleSlot.className = "sd-control";
  roleRow.append(label("Injection Role", "Role of the temporary prompt message."), roleSlot);
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
  panel.append(heading, intro, templateRow, roleRow, clearRow, actions);
  root.append(style, panel);
  const template = ctx.components.mountTextArea(templateSlot, { value: DEFAULT_TEMPLATE, rows: 6, ariaLabel: "Prompt Template", onChange: () => scheduleSave() });
  const role = ctx.components.mountSelect(roleSlot, {
    value: "system",
    options: [{ value: "system", label: "System" }, { value: "user", label: "User" }],
    ariaLabel: "Injection Role",
    onChange: () => scheduleSave()
  });
  const clear = ctx.components.mountSwitch(clearSlot, { checked: true, ariaLabel: "Clear Input After Guide", onChange: () => scheduleSave() });
  let current = DEFAULT_SETTINGS;
  let busy = false;
  let requestCounter = 0;
  const waiting = /* @__PURE__ */ new Map();
  function request(type, data = {}) {
    const requestId = `${Date.now()}-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error("The extension backend did not respond."));
      }, 5e3);
      waiting.set(requestId, { resolve, reject, timer });
      ctx.sendToBackend({ type, requestId, ...data });
    });
  }
  const unsubscribe = ctx.onBackendMessage((raw) => {
    const msg = raw;
    const waiter = msg?.requestId && waiting.get(msg.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiting.delete(msg.requestId);
    if (msg.type === "error") waiter.reject(new Error(msg.message || "Scene Direction failed."));
    else waiter.resolve(msg);
  });
  let saveTimer;
  let saveTail = Promise.resolve();
  function snapshot() {
    return normalizeSettings({ template: template.getValue(), role: role.getValue(), clearInput: clear.getValue() });
  }
  function show(value) {
    current = value;
    template.update({ value: value.template });
    role.update({ value: value.role });
    clear.update({ checked: value.clearInput });
  }
  function persist(override) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = void 0;
    const next = override ?? snapshot();
    status.textContent = "Saving\u2026";
    saveTail = saveTail.catch(() => {
    }).then(async () => {
      await request("settings:save", { settings: next });
      current = next;
      status.textContent = "Saved.";
    }).catch((error) => {
      status.textContent = error.message;
      throw error;
    });
    return saveTail;
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    status.textContent = "Unsaved changes";
    saveTimer = setTimeout(() => {
      void persist().catch(() => {
      });
    }, 500);
  }
  reset.addEventListener("click", () => {
    const next = { ...snapshot(), template: DEFAULT_TEMPLATE };
    template.update({ value: DEFAULT_TEMPLATE });
    void persist(next).catch(() => {
    });
  });
  void request("settings:get").then((result) => show(normalizeSettings(result.settings))).catch((error) => {
    status.textContent = error.message;
  });
  const action = ctx.ui.registerInputBarAction({ id: "guide-response", label: "Guide Response" });
  const offClick = action.onClick(() => {
    void guide();
  });
  async function guide() {
    if (busy) return;
    busy = true;
    let token;
    let chatId;
    let original;
    let clicked = false;
    try {
      if (saveTimer) await persist();
      else await saveTail;
      chatId = ctx.getActiveChat().chatId ?? void 0;
      if (!chatId) throw new Error("Open a chat before guiding a response.");
      const { send } = composer();
      if (!send) throw new Error("The native fresh-reply button is unavailable. Wait for the current generation to finish.");
      original = readDraft();
      if (!original.trim()) throw new Error("Enter a scene direction first.");
      if (!current.template.trim()) throw new Error("Prompt Template cannot be empty.");
      setDraft("");
      const nativeSend = await waitForEmptyComposer();
      if (ctx.getActiveChat().chatId !== chatId) throw new Error("The active chat changed.");
      token = crypto.randomUUID();
      await request("guide:arm", { chatId, token, input: original });
      if (ctx.getActiveChat().chatId !== chatId || readDraft() !== "") throw new Error("The chat draft changed before generation started.");
      nativeSend.click();
      clicked = true;
      if (!current.clearInput) setTimeout(() => {
        if (ctx.getActiveChat().chatId === chatId && readDraft() === "") setDraft(original);
      }, 1e3);
    } catch (error) {
      if (token && chatId) void request("guide:cancel", { chatId, token }).catch(() => {
      });
      if (!clicked && original !== void 0 && ctx.getActiveChat().chatId === chatId && readDraft() === "") setDraft(original);
      status.textContent = error instanceof Error ? error.message : "Guide Response failed.";
      window.alert(status.textContent);
    } finally {
      if (clicked) setTimeout(() => {
        busy = false;
      }, 2e3);
      else busy = false;
    }
  }
  return () => {
    if (saveTimer) clearTimeout(saveTimer);
    offClick();
    action.destroy();
    template.destroy();
    role.destroy();
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
