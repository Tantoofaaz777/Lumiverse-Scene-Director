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

// src/action-icons.ts
var GUIDE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m4 11 16-4-1-4L3 7l1 4Z"/><path d="m8 6 3 4m3-6 3 4M4 11v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7M4 14h16"/></svg>';
var SIMPLE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13"/><path d="M19 2v6m-3-3h6"/></svg>';

// src/toolbar.ts
function mountGuideToolbar(onClick, onSimpleSend, state, onRecover, refreshActions) {
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
  button.innerHTML = GUIDE_ICON;
  button.addEventListener("click", onClick);
  const simple = document.createElement("button");
  simple.type = "button";
  simple.setAttribute("aria-label", "Simple Send");
  simple.innerHTML = SIMPLE_ICON;
  simple.addEventListener("click", onSimpleSend);
  const recovery = document.createElement("button");
  recovery.type = "button";
  recovery.setAttribute("aria-label", "Recover draft");
  recovery.title = "Recover text from an unconfirmed Simple Send";
  recovery.textContent = "\u21B6";
  recovery.addEventListener("click", onRecover);
  toolbar.append(style, button, simple, recovery);
  let disposed = false;
  function refresh() {
    if (disposed) return;
    refreshActions();
    const { ready, busy, drafts, integrated } = state();
    if (button.hidden !== integrated) button.hidden = integrated;
    if (simple.hidden !== integrated) simple.hidden = integrated;
    const actionDisplay = integrated ? "none" : "inline-flex";
    if (button.style.display !== actionDisplay) button.style.display = actionDisplay;
    if (simple.style.display !== actionDisplay) simple.style.display = actionDisplay;
    if (integrated && !drafts) {
      toolbar.remove();
      return;
    }
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
    if (recovery.hidden !== !drafts) recovery.hidden = !drafts;
    const recoveryDisplay = drafts ? "inline-flex" : "none";
    if (recovery.style.display !== recoveryDisplay) recovery.style.display = recoveryDisplay;
    if (recovery.disabled !== busy) recovery.disabled = busy;
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
      recovery.removeEventListener("click", onRecover);
      toolbar.remove();
    }
  };
}

// src/native-save.ts
function observeNativeSave(chatId, text, signal, dispatch) {
  if (typeof window.fetch !== "function") return Promise.reject(new Error("The native save transport is unavailable."));
  return new Promise((resolve, reject) => {
    const previous = window.fetch;
    let settled = false;
    let captured = false;
    let expectedContent = "";
    let timer;
    const detach = () => {
      if (window.fetch === observe) window.fetch = previous;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detach();
      signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish();
    const uncertain = () => finish(new Error("Could not confirm Simple Send. Check the chat history before retrying. Your text is available in Recover draft."));
    const matches = (input, init) => {
      if (init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string") return false;
      try {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
        if (!url.pathname.endsWith(`/chats/${encodeURIComponent(chatId)}/messages`)) return false;
        const body = JSON.parse(init.body);
        const matching = body.is_user === true && typeof body.content === "string" && (body.content === text.trim() || body.content.startsWith(`${text.trim()}

`));
        if (matching) expectedContent = body.content;
        return matching;
      } catch {
        return false;
      }
    };
    const observe = (input, init) => {
      const selected = !settled && !captured && matches(input, init);
      if (selected) {
        captured = true;
        detach();
        clearTimeout(timer);
        timer = setTimeout(uncertain, 35e3);
      }
      try {
        const response = previous.call(window, input, init);
        if (selected) void response.then(async (result) => {
          if (!result.ok) throw new Error(`Simple Send failed (HTTP ${result.status}).`);
          const message = await result.clone().json();
          if (typeof message?.id !== "string" || message.chat_id !== chatId || message.is_user !== true || message.content !== expectedContent) throw new Error("Unexpected save response.");
          finish();
        }).catch((error) => finish(new Error(`${error instanceof Error ? error.message : "Save connection failed."} Check history before retrying; your text is available in Recover draft.`)));
        return response;
      } catch (error) {
        if (selected) uncertain();
        throw error;
      }
    };
    timer = setTimeout(uncertain, 15e3);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    window.fetch = observe;
    try {
      dispatch();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Simple Send failed."));
    }
  });
}

// src/simple-send.ts
async function simpleSend(ctx, signal, drafts) {
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
  const savedDraft = drafts.add(chatId, original);
  await observeNativeSave(chatId, original, signal, () => {
    current.send.dispatchEvent(new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
      metaKey: true
    }));
  });
  if (!signal.aborted) drafts.remove(savedDraft);
}

// src/draft-recovery.ts
var KEY = "scene-direction:simple-send-drafts";
function draftRecovery(ctx, changed) {
  let drafts = [];
  let dialog;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(KEY) || "[]");
    if (Array.isArray(stored)) drafts = stored.filter((d) => typeof d?.id === "string" && typeof d.chatId === "string" && typeof d.text === "string");
  } catch {
  }
  function write(next) {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
    drafts = next;
    changed();
  }
  function remove(id) {
    write(drafts.filter((d) => d.id !== id));
  }
  function forChat() {
    return drafts.filter((d) => d.chatId === ctx.getActiveChat().chatId);
  }
  function close() {
    dialog?.remove();
    dialog = void 0;
  }
  function open() {
    close();
    dialog = document.createElement("dialog");
    dialog.className = "sd-draft-recovery";
    dialog.setAttribute("aria-label", "Recover Simple Send draft");
    dialog.style.cssText = "max-width:560px;width:85%;background:var(--lumiverse-bg,#1b1b1b);color:var(--lumiverse-text);border:1px solid var(--lumiverse-border);border-radius:12px;padding:20px;";
    const style = document.createElement("style");
    style.textContent = ".sd-draft-recovery button { margin:4px; padding:7px 12px; border-radius:8px; border:1px solid var(--lumiverse-border); background:var(--lumiverse-fill); color:inherit; font:inherit; cursor:pointer; } .sd-draft-recovery button:focus-visible { outline:2px solid var(--lumiverse-accent); } .sd-draft-recovery::backdrop { background:#0008; }";
    dialog.append(style);
    const info = document.createElement("p");
    info.textContent = "Check the chat history before restoring an unconfirmed send. These copies contain text only; reattach files if needed.";
    dialog.append(info);
    for (const draft of forChat()) {
      const entry = document.createElement("section");
      const copy = document.createElement("textarea");
      copy.readOnly = true;
      copy.value = draft.text;
      copy.rows = 4;
      copy.setAttribute("aria-label", "Saved draft text");
      copy.style.cssText = "box-sizing:border-box;width:100%;background:var(--lumiverse-fill);color:inherit;margin:8px 0;";
      const restore = document.createElement("button");
      restore.textContent = "Restore to input";
      restore.type = "button";
      restore.addEventListener("click", () => {
        try {
          if (ctx.getActiveChat().chatId !== draft.chatId || composer().input.value !== "") throw new Error("Open the original chat with an empty input before restoring. You can also copy the text above.");
          setDraft(draft.text);
          remove(draft.id);
          entry.remove();
          if (!forChat().length) close();
        } catch (error) {
          window.alert(error instanceof Error ? error.message : "Could not restore the draft.");
        }
      });
      const discard = document.createElement("button");
      discard.type = "button";
      discard.textContent = "Discard copy";
      discard.addEventListener("click", () => {
        try {
          remove(draft.id);
          entry.remove();
          if (!forChat().length) close();
        } catch {
          window.alert("Could not remove the saved copy.");
        }
      });
      entry.append(copy, restore, discard);
      dialog.append(entry);
    }
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "Close";
    done.addEventListener("click", close);
    dialog.append(done);
    document.body.append(dialog);
    dialog.showModal();
  }
  return {
    add(chatId, text) {
      const id = crypto.randomUUID();
      write([...drafts, { id, chatId, text }]);
      return id;
    },
    remove,
    open,
    count: () => forChat().length,
    destroy: close
  };
}

// src/composer-actions.ts
function composerActions(ctx, state, guide, simple) {
  let handles = [];
  let enabled = [];
  let disposed = false;
  function allowed(index) {
    if (disposed || handles.length !== 2) return false;
    const { ready, busy } = state();
    try {
      const current = composer();
      return !busy && (index !== 0 || ready) && Boolean(current.send && current.input.value.trim());
    } catch {
      return false;
    }
  }
  function remove() {
    const previous = handles;
    handles = [];
    enabled = [];
    for (const handle of previous) handle.destroy();
  }
  return {
    active: () => handles.length === 2,
    setActive(active) {
      if (disposed || active === (handles.length === 2)) return;
      if (!active) {
        remove();
        return;
      }
      try {
        for (const [index, action] of [
          { id: "scene_direction.guide", label: "Guide Response", subtitle: "Use the draft as a temporary scene direction for the next reply.", iconSvg: GUIDE_ICON },
          { id: "scene_direction.simple_send", label: "Simple Send", subtitle: "Save the draft as a user message without generating a reply.", iconSvg: SIMPLE_ICON }
        ].entries()) {
          const handle = ctx.ui.registerInputBarAction({ ...action, enabled: false });
          handles.push(handle);
          enabled.push(false);
          handle.onClick(() => {
            if (handles[index] === handle && allowed(index)) (index === 0 ? guide : simple)();
          });
        }
      } catch (error) {
        remove();
        throw error;
      }
    },
    refresh() {
      handles.forEach((handle, index) => {
        const available = allowed(index);
        if (enabled[index] !== available) {
          enabled[index] = available;
          handle.setEnabled(available);
        }
        for (const slot of Array.from(document.querySelectorAll("[data-composer-action]"))) {
          if (!slot.getAttribute("data-composer-action")?.endsWith(`:${handle.actionId}`)) continue;
          const button = slot.querySelector("button");
          if (button && button.disabled !== !available) button.disabled = !available;
        }
      });
    },
    destroy() {
      disposed = true;
      remove();
    }
  };
}

// src/suite.ts
function watchSuite(ctx, changed) {
  let disposed = false;
  let pending = false;
  let controller;
  let timer;
  let status = "checking";
  function publish(next) {
    if (disposed || next === status) return;
    status = next;
    changed(next);
  }
  async function refresh() {
    if (disposed) return;
    if (controller) {
      pending = true;
      return;
    }
    clearTimeout(timer);
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), 5e3);
    try {
      const response = await window.fetch("/api/v1/spindle", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: request.signal
      });
      if (!response.ok) throw new Error("Extension list unavailable");
      const data = await response.json();
      const extensions = data?.extensions;
      if (!Array.isArray(extensions)) throw new Error("Invalid extension list");
      const suite = extensions.find((item) => item?.identifier === "lumiverse_suite");
      if (!pending) publish(!suite ? "missing" : suite.enabled === true && suite.has_frontend === true ? "active" : "disabled");
    } catch {
      if (!pending) publish("unavailable");
    } finally {
      clearTimeout(timeout);
      controller = void 0;
      if (!disposed) {
        const delay = pending ? 0 : 3e4;
        pending = false;
        timer = setTimeout(() => {
          void refresh();
        }, delay);
      }
    }
  }
  const onReturn = () => {
    void refresh();
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") onReturn();
  };
  const unsubscribers = ["SPINDLE_EXTENSION_LOADED", "SPINDLE_EXTENSION_UNLOADED", "SPINDLE_EXTENSION_STATUS", "SPINDLE_EXTENSION_ERROR", "SPINDLE_BATCH_CHANGED"].map((event) => ctx.events.on(event, onReturn));
  window.addEventListener("online", onReturn);
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", onVisible);
  void refresh();
  return () => {
    disposed = true;
    clearTimeout(timer);
    controller?.abort();
    for (const unsubscribe of unsubscribers) unsubscribe();
    window.removeEventListener("online", onReturn);
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onVisible);
  };
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
  const integrationRow = document.createElement("div");
  integrationRow.className = "sd-row";
  const integrationSlot = document.createElement("div");
  integrationSlot.className = "sd-control";
  const integrationLabel = label("Integrate with Customize composer", "Checking Lumiverse Suite\u2026");
  const integrationHint = integrationLabel.querySelector(".sd-hint");
  integrationHint.id = "sd-composer-integration-hint";
  integrationRow.append(integrationLabel, integrationSlot);
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
  panel.append(heading, intro, templateRow, clearRow, integrationRow, actions);
  root.append(style, panel);
  const template = ctx.components.mountTextArea(templateSlot, { value: DEFAULT_TEMPLATE, rows: 6, ariaLabel: "Prompt Template", disabled: true, onChange: () => scheduleSave() });
  const clear = ctx.components.mountSwitch(clearSlot, { checked: true, ariaLabel: "Clear Input After Guide", disabled: true, onChange: () => scheduleSave() });
  const integration = ctx.components.mountSwitch(integrationSlot, {
    checked: false,
    ariaLabel: "Integrate with Customize composer",
    disabled: true,
    onChange: () => {
      scheduleSave();
      reconcileIntegration();
    }
  });
  const labelSwitch = () => {
    for (const [slot, name] of [[clearSlot, "Clear Input After Guide"], [integrationSlot, "Integrate with Customize composer"]]) {
      const button = slot.querySelector('[role="switch"]');
      if (button && button.getAttribute("aria-label") !== name) button.setAttribute("aria-label", name);
      if (slot === integrationSlot && button && button.getAttribute("aria-describedby") !== integrationHint.id) button.setAttribute("aria-describedby", integrationHint.id);
    }
  };
  const switchObserver = new MutationObserver(labelSwitch);
  switchObserver.observe(clearSlot, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-label"] });
  switchObserver.observe(integrationSlot, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-label", "aria-describedby"] });
  labelSwitch();
  let current = DEFAULT_SETTINGS;
  let disposed = false;
  let busy = false;
  let simpleController;
  let settingsReady = false;
  let suiteStatus = "checking";
  let settingsLoad;
  let settingsRetry;
  let settingsDirty = false;
  let settingsRevision = 0;
  let saving = 0;
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
    clearTimeout(guide2.recoveryTimer);
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
  async function recover(guide2) {
    if (disposed || active !== guide2 || !guide2.tracking || guide2.polling) return;
    clearTimeout(guide2.recoveryTimer);
    guide2.polling = true;
    try {
      await request("guide:status", { chatId: guide2.chatId, token: guide2.token });
    } catch {
    } finally {
      guide2.polling = false;
      if (!disposed && active === guide2) scheduleRecovery(guide2);
    }
  }
  function scheduleRecovery(guide2) {
    clearTimeout(guide2.recoveryTimer);
    guide2.recoveryTimer = setTimeout(() => {
      void recover(guide2);
    }, 5e3);
  }
  const recoverOnReturn = () => {
    if (disposed) return;
    if (active) void recover(active);
    if (!settingsReady) void loadSettings().catch(() => {
    });
    else if (settingsDirty && !saving) void persist().catch(() => {
    });
  };
  const recoverOnVisible = () => {
    if (document.visibilityState === "visible") recoverOnReturn();
  };
  window.addEventListener("online", recoverOnReturn);
  window.addEventListener("focus", recoverOnReturn);
  document.addEventListener("visibilitychange", recoverOnVisible);
  const unsubscribe = ctx.onBackendMessage((raw) => {
    const msg = raw;
    if (!msg) return;
    if (active && msg.token === active.token && msg.chatId === active.chatId) {
      const guide2 = active;
      if (msg.type === "guide:started") {
        if (!guide2.started && !guide2.clearInput) restore(guide2);
        guide2.started = true;
        status.textContent = "Preparing the guided response\u2026";
      } else if (msg.type === "guide:consumed") {
        if (!guide2.started && !guide2.clearInput) restore(guide2);
        guide2.started = true;
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
    return normalizeSettings({ version: 2, template: template.getValue(), clearInput: clear.getValue(), integrateComposer: integration.getValue() });
  }
  function show(value) {
    current = value;
    template.update({ value: value.template });
    clear.update({ checked: value.clearInput });
    integration.update({ checked: value.integrateComposer });
  }
  function persist(override) {
    clearTimeout(saveTimer);
    saveTimer = void 0;
    const next = override ?? snapshot();
    const revision = settingsRevision;
    settingsDirty = true;
    saving++;
    status.textContent = "Saving\u2026";
    const operation = saveTail.then(async () => {
      await request("settings:save", { settings: next });
      current = next;
      if (revision === settingsRevision) {
        settingsDirty = false;
        if (!disposed) status.textContent = "Saved.";
      }
    }).catch((error) => {
      if (!disposed) status.textContent = error.message;
      throw error;
    }).finally(() => {
      saving--;
    });
    saveTail = operation.catch(() => {
    });
    return operation;
  }
  function scheduleSave() {
    settingsDirty = true;
    settingsRevision++;
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
    settingsRevision++;
    void persist(next).catch(() => {
    });
  });
  function loadSettings() {
    if (disposed || settingsReady) return Promise.resolve();
    if (settingsLoad) return settingsLoad;
    clearTimeout(settingsRetry);
    settingsLoad = request("settings:get").then((result) => {
      if (disposed) return;
      show(normalizeSettings(result.settings));
      template.update({ disabled: false });
      clear.update({ disabled: false });
      reset.disabled = false;
      settingsReady = true;
      status.textContent = "";
      reconcileIntegration();
      toolbar.refresh();
    }).catch((error) => {
      if (!disposed) {
        status.textContent = error.message;
        settingsRetry = setTimeout(() => {
          void loadSettings().catch(() => {
          });
        }, 5e3);
      }
      throw error;
    }).finally(() => {
      settingsLoad = void 0;
    });
    return settingsLoad;
  }
  const nativeActions = composerActions(ctx, () => ({ ready: settingsReady, busy }), () => {
    void guide();
  }, () => {
    void sendOnly();
  });
  const drafts = draftRecovery(ctx, () => toolbar.refresh());
  const toolbar = mountGuideToolbar(() => {
    void guide();
  }, () => {
    void sendOnly();
  }, () => ({ ready: settingsReady, busy, drafts: drafts.count(), integrated: nativeActions.active() }), () => drafts.open(), () => nativeActions.refresh());
  function reconcileIntegration() {
    if (disposed) return;
    const available = suiteStatus === "active" && typeof ctx.ui.registerInputBarAction === "function";
    integration.update({ disabled: !settingsReady || !available });
    const hints = {
      checking: "Checking Lumiverse Suite\u2026",
      missing: "Install and enable Lumiverse Suite to use this option. Using the standard button bar.",
      disabled: "Enable Lumiverse Suite to use this option. Using the standard button bar.",
      unavailable: "Could not check Lumiverse Suite. Using the standard button bar; checking again automatically.",
      active: "Enable to register Guide Response and Simple Send, then add and arrange them in Customize composer. Off keeps the standard button bar."
    };
    integrationHint.textContent = suiteStatus === "active" && !available ? "This Lumiverse version does not support input action registration. Using the standard button bar." : hints[suiteStatus];
    try {
      nativeActions.setActive(settingsReady && available && integration.getValue());
    } catch {
      integrationHint.textContent = "Could not register composer actions. Using the standard button bar. Toggle this option to retry.";
    }
    toolbar.refresh();
  }
  const stopWatchingSuite = watchSuite(ctx, (value) => {
    suiteStatus = value;
    reconcileIntegration();
  });
  void loadSettings().catch(() => {
  });
  async function sendOnly() {
    if (busy || disposed) return;
    busy = true;
    const controller = new AbortController();
    simpleController = controller;
    toolbar.refresh();
    try {
      status.textContent = "Sending your message\u2026";
      await simpleSend(ctx, controller.signal, drafts);
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
      await loadSettings();
      await saveTail;
      if (saveTimer || settingsDirty) await persist();
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
      attempt.tracking = true;
      scheduleRecovery(attempt);
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
      clearTimeout(active.recoveryTimer);
    }
    disposed = true;
    simpleController?.abort();
    window.removeEventListener("online", recoverOnReturn);
    window.removeEventListener("focus", recoverOnReturn);
    document.removeEventListener("visibilitychange", recoverOnVisible);
    clearTimeout(saveTimer);
    clearTimeout(settingsRetry);
    switchObserver.disconnect();
    stopWatchingSuite();
    toolbar.destroy();
    nativeActions.destroy();
    drafts.destroy();
    template.destroy();
    clear.destroy();
    integration.destroy();
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
