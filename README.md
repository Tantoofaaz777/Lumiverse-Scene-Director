# Scene Direction for Lumiverse

Use a normal chat draft as an invisible, one-shot instruction for the next native fresh reply. The extension does not create a user chat message or call a separate LLM endpoint.

## Compatibility and installation

Built against the Lumiverse **staging** source inspected on 2026-09-25. Install this repository through Lumiverse's Extensions panel, or copy/host its contents as a standalone Git repository and install its URL. No Lumiverse or LumiScript changes are required. The committed `dist/` bundles allow installation without running the build locally.

For development, run `npm install`, `npm run build`, `npx tsc --noEmit`, and `npm test`. The only requested manifest permission is `interceptor`; input bar actions, settings tabs, messaging, and private user storage are free in the inspected API.

## Use

Open a chat, type a direction in the normal input, open **Extras**, and choose **Guide Response**. The native composer is cleared, and the host sends an empty-input normal generation. Its generated assistant turn streams and persists as usual. Open Lumiverse **Settings → Extensions** and scroll to **Scene Direction** (or use the extension's settings shortcut in the Extensions panel). Its official extension settings section offers a multiline Prompt Template, System/User injection role, Clear Input After Guide, and Reset Template. The controls use Lumiverse's theme-aware shared form components. Changes persist in the extension's per-user storage after a short debounce. With clearing disabled, the draft is restored shortly after the native send begins; it remains a draft and is never part of this guided generation.

The default template is:

```text
[Treat the following instruction as explicit scene direction and apply it to your response:

{{input}}]
```

Every `{{input}}` occurrence is replaced locally with the unmodified draft text. A template without it is a static instruction. An empty template or whitespace-only draft rejects the action.

## Architecture and API choices

| Stage | Mechanism |
| --- | --- |
| Input action | `ctx.ui.registerInputBarAction` |
| Chat identity | `ctx.getActiveChat()` |
| Composer | Isolated `src/composer.ts` DOM bridge: `textarea[name="chat-message"]`, its neighboring native send button, and the `lucide-send` icon in the empty-send state |
| Draft sync | Native textarea value setter and bubbling `input` event; wait two animation frames for React to render the fresh-reply button |
| Transport | `ctx.sendToBackend` / `spindle.onFrontendMessage` with a request acknowledgement and browser session routing |
| Settings | Official `ctx.ui.mount('settings_extensions')` section in Settings → Extensions with `ctx.components` form controls; `spindle.userStorage` |
| Injection | `spindle.registerInterceptor`, after normal assembly, returning a named Prompt Breakdown contribution |

The backend holds an instruction in memory only, keyed by authenticated user and chat, bound to the initiating frontend document, with a 15-second expiry and a random cancellation token. It consumes the instruction synchronously on the first matching `normal` non-Dry-Run interception. Regeneration, swipe, continue, impersonation, quiet calls, other chats, other users, and other browser documents do not consume it. The draft is restored on a pre-click error, and the backend entry is cancelled. The DOM bridge exists because staging has no public frontend action for a native empty send.

**Host limitation:** The public interceptor context identifies user, chat, document, and generation type, but exposes no frontend-issued request token. A separate normal fresh reply started in the same chat/document during the short armed window could claim the direction first. The action checks for an active generation, serializes its clicks, arms immediately before native click, and expires unconsumed entries, but the current public API cannot make this cross-action race mathematically impossible. A rejected native click also leaves an entry until expiry if it produces no generation event. Do not use the normal Send action in that chat during this window.

Staging's npm type package (0.6.36) lags the host's session routing and `required` interceptor option, so `src/backend.ts` contains narrow type assertions for those documented staging APIs. On an older Lumiverse version without session routing, the action fails closed. The send icon/DOM structure is the one small compatibility surface to update if the native composer changes.

## Manual verification on a running Lumiverse instance

1. Install and enable the extension. Confirm **Guide Response** appears under the input bar's Extras menu and the Scene Direction controls appear inside Settings → Extensions (including from the extension's settings shortcut).
2. In an existing chat, type `Make her notice a silhouette outside the window.` and choose Guide Response. Confirm the draft clears, only an assistant turn appears, and its text streams normally.
3. Open that assistant turn's **Prompt Breakdown**. Confirm the `Scene Direction` contribution contains the resolved template and exact direction. Inspect chat history; there must be no corresponding user turn.
4. Send an ordinary message or regenerate. Confirm the scene direction does not reappear in Prompt Breakdown.
5. Set role to User, edit the template to `Before {{input}} after`, reload Lumiverse, and repeat. Confirm both the saved settings and final prompt. Test a static template and the empty-template error.
6. Start a guide in Chat A and navigate to Chat B; confirm B cannot inherit A's direction. Try a rapid double click and a click while a response is streaming; confirm no extra guided generation starts.

Automated tests cover substitution, validation, pending-state isolation/consumption/cleanup, and injected role/content/breakdown. A live Lumiverse installation and provider were unavailable in this workspace, so the browser behavior above remains a manual integration check.
