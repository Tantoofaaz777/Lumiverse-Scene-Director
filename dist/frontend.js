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
  const heading = document.createElement("h2");
  heading.textContent = "Scene Direction";
  const templateLabel = document.createElement("label");
  templateLabel.textContent = "Prompt Template";
  const template = document.createElement("textarea");
  template.rows = 8;
  template.style.width = "100%";
  const roleLabel = document.createElement("label");
  roleLabel.textContent = "Injection Role";
  const role = document.createElement("select");
  for (const name of ["system", "user"]) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name === "system" ? "System" : "User";
    role.append(option);
  }
  const clearLabel = document.createElement("label");
  const clear = document.createElement("input");
  clear.type = "checkbox";
  clearLabel.append(clear, document.createTextNode(" Clear Input After Guide"));
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset Template";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  root.append(heading, templateLabel, template, roleLabel, role, clearLabel, reset, status);
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
  function show(value) {
    current = value;
    template.value = value.template;
    role.value = value.role;
    clear.checked = value.clearInput;
  }
  function save() {
    const next = normalizeSettings({ template: template.value, role: role.value, clearInput: clear.checked });
    void request("settings:save", { settings: next }).then(() => {
      current = next;
      status.textContent = "Saved.";
    }).catch((error) => {
      status.textContent = error.message;
    });
  }
  template.addEventListener("change", save);
  role.addEventListener("change", save);
  clear.addEventListener("change", save);
  reset.addEventListener("click", () => {
    template.value = DEFAULT_TEMPLATE;
    save();
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
    offClick();
    action.destroy();
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
