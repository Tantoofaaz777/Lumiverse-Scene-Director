# Scene Direction for Lumiverse

Use a normal chat draft as an invisible, one-shot instruction for the next native fresh reply with **Guide Response**, or save it as a permanent user turn without requesting an assistant response with **Simple Send**. Guide Response sends the resolved template as a temporary User message immediately after the last stored chat turn in the assembled prompt, before post-history preset instructions. Neither action calls a separate LLM endpoint.

## Compatibility and installation

Built against the Lumiverse **staging** source inspected on 2026-09-26. Install this repository through Lumiverse's Extensions panel, or copy/host its contents as a standalone Git repository and install its URL. No Lumiverse or LumiScript changes are required. The committed `dist/` bundles allow installation without running the build locally.

For development, run `npm ci`, `npm run typecheck`, and `npm test`. Tests rebuild all distributed bundles from `src/` first. Never edit `dist/` directly. The manifest requests `interceptor` to inject the direction and `generation` to observe native generation lifecycle events. **When upgrading, grant the new generation permission in Extensions.** The extension still uses the native send; it does not request generation through a separate endpoint. Input bar actions, settings components, messaging, and private user storage are free in the inspected API.

## Use

**Simple Send:** type a message and click the **message-plus button** beside Guide Response. In a local chat, it saves a normal user turn, clears the draft, and does not start an assistant generation. It delegates to Lumiverse's native Ctrl+Send (Cmd+Send on macOS) path, preserving native persona, attachment and regex-action handling. The Guide Response template and Clear Input After Guide setting do not apply. It requires a nonempty text draft and an idle native composer. Both extension buttons are disabled while awaiting the native HTTP save response. Broadcast user-message events cannot confirm this operation, even when another tab sends identical text. The extension waits up to 15 seconds for a matching request and then up to 35 seconds for its response (the host HTTP timeout is 30 seconds). An unconfirmed send is never automatically retried. Check history before retrying; native failures retain the host's own error handling.

**Recover draft:** Simple Send preserves a text copy in this tab's session storage before clicking the native control. On failure or uncertainty, a recovery button appears beside the send actions. Open it to copy, explicitly restore into the original chat's empty input, or discard the saved text. Copies survive page reloads in the same tab, are removed after a confirmed save, and are not intended to survive closing the tab. Files must be reattached manually. New input and other chats are never overwritten. If storing the copy fails, the send is refused before the input is cleared.

**Multiplayer limitation:** Simple Send delegates to the host's queue action, which routes messages through room rules when connected to multiplayer. Those rules can trigger a host generation. The save-without-generation behavior is supported for local chats; Simple Send does not override multiplayer room behavior.

Open a chat, type a direction in the normal input, and click the **clapperboard button (Guide Response)** in the row directly above the message field. It uses the Lumiverse theme, provides a tooltip and accessible label, and is disabled while settings load, the draft is empty, or a generation is busy. Guide Response is no longer inside Extras. The native composer is cleared, and the host sends an empty-input normal generation. Its generated assistant turn streams and persists as usual. Open Lumiverse **Settings → Extensions** and scroll to **Scene Direction** (or use the extension's settings shortcut in the Extensions panel). Its official extension settings section offers a multiline Prompt Template, Clear Input After Guide, and Reset Template. The controls use Lumiverse's theme-aware shared form components. Changes persist in the extension's per-user storage after a short debounce. With clearing disabled, the draft is restored shortly after the native send begins; it remains a draft and is never part of this guided generation.

The default template is:

```text
[Treat the following instruction as explicit scene direction and apply it to your response:

{{input}}]
```

Every `{{input}}` occurrence is replaced locally with the unmodified draft text, including literal `$&`, `$$`, and similar sequences. A template without it is a static instruction. An empty template or whitespace-only draft rejects the action. Remove pending attachments and selected regex send actions first: Guide Response refuses to click if clearing the text does not put the host into its empty-send state. It preserves those attachments/actions and restores the direction when still in the same composer with no new text.

The injection role is always User; role is no longer stored as a setting. Previously saved System selections are ignored while preserving the template and Clear Input After Guide preference.

For example, the assembled message order is:

```text
System: preset/persona/scenario instructions
User: earlier stored turn
Assistant: latest stored reply
User: [resolved Scene Direction template]    <- temporary message
System: any post-history preset instructions
```

The extension locates stored turns using Lumiverse's `__isChatHistory` metadata, not role names. Example dialogue, World Info, post-history prompts, and assistant prefill are preserved in place. If a nonempty prompt has no identifiable stored history (for example a flattened/custom preset or all history excluded), Guide Response reports an error instead of guessing a position. Use a native Chat History block with at least one visible turn. A completely empty message list can accept the guide as its first message. This is an insertion after prompt assembly; it does not rerun lore activation or other assembly rules as a newly saved user turn would.

## Architecture and API choices

| Stage | Mechanism |
| --- | --- |
| Input action | `src/toolbar.ts`: an owned toolbar inserted directly before the native input row, with a MutationObserver to remount it on chat navigation and track the native send state |
| Simple Send | `src/simple-send.ts`: revalidate the current chat, draft and native Send control after React renders, dispatch a Ctrl+Cmd click to the native queue path, and observe the matching native HTTP response through `src/native-save.ts`; no guide reservation or injection |
| Chat identity | `ctx.getActiveChat()` |
| Composer | Isolated `src/composer.ts` DOM bridge: `textarea[name="chat-message"]`, its neighboring native send button, the `lucide-send` icon, and a change from the nonempty-draft accessible label (locale independent) |
| Draft sync | Native textarea value setter and bubbling `input` event; wait two animation frames for React to render the fresh-reply button |
| Transport | `ctx.sendToBackend` / `spindle.onFrontendMessage` with a request acknowledgement and browser session routing |
| Settings | Official `ctx.ui.mount('settings_extensions')` section in Settings → Extensions with `ctx.components` form controls; `spindle.userStorage` |
| Injection | `spindle.registerInterceptor`, after normal assembly; insert after the last `__isChatHistory` message and report the actual index as a named Prompt Breakdown contribution |
| Lifecycle | `GENERATION_STARTED`, `GENERATION_ENDED`, and `GENERATION_STOPPED`, scoped to authenticated user, chat, document and the observed generation ID |

Settings reads retry after a timeout and on browser online/focus/visibility restoration. Failed writes retain the dirty snapshot and retry on return or the next Guide Response, without requiring another edit. Old save acknowledgements cannot mark a newer edit as saved. A scoped DOM observer supplies the native switch's accessible name because the inspected host component bridge drops ariaLabel.

The backend reserves an instruction in memory before any asynchronous settings or permissions lookup. Cancellation removes that exact reservation, so delayed reads cannot resurrect it or overwrite a newer request. An unstarted reservation expires after 15 seconds and reports a failure to its initiating document. Once the host confirms a matching native generation started, this deadline is removed: slow council/embedding/prompt assembly does not silently discard the direction. The required interceptor refuses to inject a pending direction if the start event was not observed.

While a guide is pending, the frontend queries its backend status every five seconds after the previous query settles, and immediately on browser online/focus or tab visibility restoration. Lost start, completion, failure and stop notifications can therefore be recovered without another generation or automatic retry. Transport timeouts leave the action pending until communication returns. The backend retains up to 256 terminal receipts for 24 hours, scoped to user, browser document, chat and guide token; receipts contain only the outcome, not the direction text. A confirmed failure restores the direction only into its original, empty composer in the same chat. A successful completion simply releases the extension controls. A backend restart or expired receipt reports an unknown outcome and releases the local lock; check history before retrying. Reloading the page still discards the in-memory direction. Recovery never cancels a generation merely because it is slow.

The instruction is injected once on the first matching `normal` non-Dry-Run interception. The reservation remains until that generation finishes or stops, preventing reuse and reporting errors even after injection. Regeneration, swipe, continue, impersonation, quiet calls, other chats, other users, and other browser documents do not consume it. Clear Input After Guide is applied after the host confirms start. On failure the original direction is restored only if the same composer remains open and empty; newer text is never overwritten. Settings finish loading and pending saves finish before guiding. The DOM bridge exists because staging has no public frontend action for a native empty send.

**Host limitation:** The public interceptor context identifies user, chat, document, and generation type, but exposes no frontend-issued request token. A separate normal fresh reply started in the same chat/document during the short armed window could claim the direction first. The action serializes its clicks and revalidates the live composer immediately before native click, but the current API cannot eliminate this cross-action race. A rejected click is reported when the start deadline expires. Do not use another Send action during that window. If a host request is accepted only after the deadline/cancellation, it can still generate an unguided reply; the extension cannot cancel that specific request through the current API. Multiplayer flows that reject native empty sends are not supported and will report that no generation started.

Staging's npm type package (0.6.36) lags the host's session routing and `required` interceptor option, so `src/backend.ts` contains narrow type assertions for those documented staging APIs. Hosts must advertise `frontend-session-origin-v1` and `required-interceptors-v1`. Missing capabilities or permissions reject the action. The DOM structure, icon and accessible-label transition must be rechecked if the native composer changes. For Simple Send, a temporary transparent wrapper around this document's fetch observes the first matching JSON POST to the native chat messages endpoint (chat, user role and draft content). It restores the previous transport as soon as the request is captured, or on timeout/unload, and never modifies the request or consumes the original response body. A newer wrapper installed by another extension is preserved. This bridge depends on the inspected host client using fetch with a JSON string; an incompatible transport keeps the recovery copy and reports an unconfirmed send. Concurrent same-content writes by another extension within the same document before native dispatch remain ambiguous; other browser documents do not share this observer.

## Manual verification on a running Lumiverse instance

1. Install and enable the extension. Confirm the **Guide Response** clapperboard button appears directly above the message field, remains present after switching chats without duplicating, and is disabled during generation. Confirm the Scene Direction controls appear inside Settings → Extensions (including from the extension's settings shortcut).
2. In an existing chat, type `Make her notice a silhouette outside the window.` and choose Guide Response. Confirm the draft clears, only an assistant turn appears, and its text streams normally.
3. Open that assistant turn's **Prompt Breakdown**. Confirm the `Scene Direction` contribution contains the resolved template and exact direction. Inspect the assembled messages: it must follow the last stored chat turn and precede post-history blocks. In the saved chat history there must be no corresponding user turn. Provider/post-processing rules can merge adjacent messages or adapt roles to the provider format.
4. Send an ordinary message or regenerate. Confirm the scene direction does not reappear in Prompt Breakdown.
5. Confirm the injected role is always User, including after upgrading a saved System selection. Edit the template to `Before {{input}} after`, reload Lumiverse, and repeat. Test a static template and the empty-template error.
6. Start a guide in Chat A and navigate to Chat B; confirm B cannot inherit A's direction. Try a rapid double click and a click while a response is streaming; confirm no extra guided generation starts.
7. Try with a pending attachment or selected regex send action. Confirm no message is sent, the direction is restored, and the attachment/action remains pending.
8. Test an instruction containing `$&` and `$$`. Confirm exact text in Prompt Breakdown. Test assembly lasting over 15 seconds, provider failure, and Stop during assembly; verify the instruction is retained for slow assembly and failures are reported without leaking it into the next response.
9. In a local chat, type a normal message and click **Simple Send**. Confirm exactly one permanent user turn appears with the active persona, the draft clears, and no assistant generation starts. Reload to verify persistence. Repeat with an attachment and with a selected regex send action. Send a later normal message and confirm the queued user turn is in its history. Check that both extension buttons block repeated clicks while saving and that Simple Send is disabled during a guided or ordinary generation.
10. Start a guided generation, disconnect the browser from Lumiverse without reloading, and let the generation finish or fail on the server. Reconnect and confirm the extension buttons leave the busy state. On failure, confirm the direction returns only if the original input is still empty; on success, it stays cleared. Repeat with a new draft and after switching chats to confirm recovery never overwrites another input. No second generation should be triggered.

Automated tests cover end-of-history placement, settings migration, literal substitution, asynchronous cancellation, permissions, lifecycle isolation, slow assembly, one-shot injection, and frontend behavior in jsdom with a simulated host contract, including toolbar remounting, disabled states and coexistence with another extension toolbar. Simple Send tests cover modifier routing on Windows/Linux/macOS, draft handling, settings independence, concurrent clicks, navigation, teardown and unconfirmed saves. Persona/attachment preservation is simulated through the native path; it still requires the live checks above. A real Lumiverse browser session and provider were not exercised.

Additional manual checks for 1.0.9: delay initial settings beyond five seconds, then restore the connection; verify controls recover. Force a settings-save failure and retry Guide Response without editing again. Force an HTTP save failure and use Recover draft, including after reload and with newer text in the input. Verify the switch has an accessible name and that another tab's message does not unlock a pending send. Automated regression tests cover these failure paths and transparent transport cleanup; real host UI/provider testing is still required.
