# Scene Direction for Lumiverse

Use a normal chat draft as an invisible, one-shot instruction for the next native fresh reply with **Guide Response**, or save it as a permanent user turn without requesting an assistant response with **Simple Send**. Guide Response sends the resolved template as a temporary User message immediately after the last stored chat turn in the assembled prompt, before post-history preset instructions. Neither action calls a separate LLM endpoint.

## Compatibility and installation

Built against the Lumiverse **staging** source inspected on 2026-09-26. Install this repository through Lumiverse's Extensions panel, or copy/host its contents as a standalone Git repository and install its URL. No Lumiverse or LumiScript changes are required. The committed `dist/` bundles allow installation without running the build locally.

For development, run `npm ci`, `npm run typecheck`, and `npm test`. Tests rebuild all distributed bundles from `src/` first. Never edit `dist/` directly. The manifest requests `interceptor` to inject the direction and `generation` to observe native generation lifecycle events. **When upgrading, grant the new generation permission in Extensions.** The extension still uses the native send; it does not request generation through a separate endpoint. Input bar actions, settings components, messaging, and private user storage are free in the inspected API.

## Use

**Simple Send:** type a message and click the **message-plus button** beside Guide Response. In a local chat, it saves a normal user turn, clears the draft, and does not start an assistant generation. It delegates to Lumiverse's native Ctrl+Send (Cmd+Send on macOS) path, preserving native persona, attachment and regex-action handling. The Guide Response template and Clear Input After Guide setting do not apply. It requires a nonempty text draft and an idle native composer. Both extension buttons are disabled while this send awaits a user-message confirmation; an unconfirmed send reports an error after 15 seconds and is never automatically retried. Check the history before retrying, since a save can succeed even if its confirmation is lost. Native failures retain the host's own error handling.

**Multiplayer limitation:** Simple Send delegates to the host's queue action, which routes messages through room rules when connected to multiplayer. Those rules can trigger a host generation. The save-without-generation behavior is supported for local chats; Simple Send does not override multiplayer room behavior.

Open a chat, type a direction in the normal input, and click the **clapperboard button (Guide Response)** in the row directly above the message field. It uses the Lumiverse theme, provides a tooltip and accessible label, and is disabled while settings load, the draft is empty, or a generation is busy. Guide Response is no longer inside Extras. The native composer is cleared, and the host sends an empty-input normal generation. Its generated assistant turn streams and persists as usual. Open Lumiverse **Settings → Extensions** and scroll to **Scene Direction** (or use the extension's settings shortcut in the Extensions panel). Its official extension settings section offers a multiline Prompt Template, System/User injection role, Clear Input After Guide, and Reset Template. The controls use Lumiverse's theme-aware shared form components. Changes persist in the extension's per-user storage after a short debounce. With clearing disabled, the draft is restored shortly after the native send begins; it remains a draft and is never part of this guided generation.

The default template is:

```text
[Treat the following instruction as explicit scene direction and apply it to your response:

{{input}}]
```

Every `{{input}}` occurrence is replaced locally with the unmodified draft text, including literal `$&`, `$$`, and similar sequences. A template without it is a static instruction. An empty template or whitespace-only draft rejects the action. Remove pending attachments and selected regex send actions first: Guide Response refuses to click if clearing the text does not put the host into its empty-send state. It preserves those attachments/actions and restores the direction when still in the same composer with no new text.

User is the default injection role. Legacy settings migrate to User while preserving the template and Clear Input After Guide preference. You can explicitly select System again after upgrading; this changes the role but keeps the same position at the end of history.

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
| Simple Send | `src/simple-send.ts`: revalidate the current chat, draft and native Send control after React renders, dispatch a Ctrl+Cmd click to the native queue path, and observe `ctx.events` MESSAGE_SENT; no guide reservation or injection |
| Chat identity | `ctx.getActiveChat()` |
| Composer | Isolated `src/composer.ts` DOM bridge: `textarea[name="chat-message"]`, its neighboring native send button, the `lucide-send` icon, and a change from the nonempty-draft accessible label (locale independent) |
| Draft sync | Native textarea value setter and bubbling `input` event; wait two animation frames for React to render the fresh-reply button |
| Transport | `ctx.sendToBackend` / `spindle.onFrontendMessage` with a request acknowledgement and browser session routing |
| Settings | Official `ctx.ui.mount('settings_extensions')` section in Settings → Extensions with `ctx.components` form controls; `spindle.userStorage` |
| Injection | `spindle.registerInterceptor`, after normal assembly; insert after the last `__isChatHistory` message and report the actual index as a named Prompt Breakdown contribution |
| Lifecycle | `GENERATION_STARTED`, `GENERATION_ENDED`, and `GENERATION_STOPPED`, scoped to authenticated user, chat, document and the observed generation ID |

The backend reserves an instruction in memory before any asynchronous settings or permissions lookup. Cancellation removes that exact reservation, so delayed reads cannot resurrect it or overwrite a newer request. An unstarted reservation expires after 15 seconds and reports a failure to its initiating document. Once the host confirms a matching native generation started, this deadline is removed: slow council/embedding/prompt assembly does not silently discard the direction. The required interceptor refuses to inject a pending direction if the start event was not observed.

The instruction is injected once on the first matching `normal` non-Dry-Run interception. The reservation remains until that generation finishes or stops, preventing reuse and reporting errors even after injection. Regeneration, swipe, continue, impersonation, quiet calls, other chats, other users, and other browser documents do not consume it. Clear Input After Guide is applied after the host confirms start. On failure the original direction is restored only if the same composer remains open and empty; newer text is never overwritten. Settings finish loading and pending saves finish before guiding. The DOM bridge exists because staging has no public frontend action for a native empty send.

**Host limitation:** The public interceptor context identifies user, chat, document, and generation type, but exposes no frontend-issued request token. A separate normal fresh reply started in the same chat/document during the short armed window could claim the direction first. The action serializes its clicks and revalidates the live composer immediately before native click, but the current API cannot eliminate this cross-action race. A rejected click is reported when the start deadline expires. Do not use another Send action during that window. If a host request is accepted only after the deadline/cancellation, it can still generate an unguided reply; the extension cannot cancel that specific request through the current API. Multiplayer flows that reject native empty sends are not supported and will report that no generation started.

Staging's npm type package (0.6.36) lags the host's session routing and `required` interceptor option, so `src/backend.ts` contains narrow type assertions for those documented staging APIs. Hosts must advertise `frontend-session-origin-v1` and `required-interceptors-v1`. Missing capabilities or permissions reject the action. The DOM structure, icon and accessible-label transition must be rechecked if the native composer changes.

## Manual verification on a running Lumiverse instance

1. Install and enable the extension. Confirm the **Guide Response** clapperboard button appears directly above the message field, remains present after switching chats without duplicating, and is disabled during generation. Confirm the Scene Direction controls appear inside Settings → Extensions (including from the extension's settings shortcut).
2. In an existing chat, type `Make her notice a silhouette outside the window.` and choose Guide Response. Confirm the draft clears, only an assistant turn appears, and its text streams normally.
3. Open that assistant turn's **Prompt Breakdown**. Confirm the `Scene Direction` contribution contains the resolved template and exact direction. Inspect the assembled messages: it must follow the last stored chat turn and precede post-history blocks. In the saved chat history there must be no corresponding user turn. Provider/post-processing rules can merge adjacent messages or adapt roles to the provider format.
4. Send an ordinary message or regenerate. Confirm the scene direction does not reappear in Prompt Breakdown.
5. Confirm User is the default role, including after upgrading legacy settings. Edit the template to `Before {{input}} after`, reload Lumiverse, and repeat. Test an explicit System selection: it must retain the end-of-history position. Test a static template and the empty-template error.
6. Start a guide in Chat A and navigate to Chat B; confirm B cannot inherit A's direction. Try a rapid double click and a click while a response is streaming; confirm no extra guided generation starts.
7. Try with a pending attachment or selected regex send action. Confirm no message is sent, the direction is restored, and the attachment/action remains pending.
8. Test an instruction containing `$&` and `$$`. Confirm exact text in Prompt Breakdown. Test assembly lasting over 15 seconds, provider failure, and Stop during assembly; verify the instruction is retained for slow assembly and failures are reported without leaking it into the next response.
9. In a local chat, type a normal message and click **Simple Send**. Confirm exactly one permanent user turn appears with the active persona, the draft clears, and no assistant generation starts. Reload to verify persistence. Repeat with an attachment and with a selected regex send action. Send a later normal message and confirm the queued user turn is in its history. Check that both extension buttons block repeated clicks while saving and that Simple Send is disabled during a guided or ordinary generation.

Automated tests cover end-of-history placement, settings migration, literal substitution, asynchronous cancellation, permissions, lifecycle isolation, slow assembly, one-shot injection, and frontend behavior in jsdom with a simulated host contract, including toolbar remounting, disabled states and coexistence with another extension toolbar. Simple Send tests cover modifier routing on Windows/Linux/macOS, draft handling, settings independence, concurrent clicks, navigation, teardown and unconfirmed saves. Persona/attachment preservation is simulated through the native path; it still requires the live checks above. A real Lumiverse browser session and provider were not exercised.
