// Native composer bridge: the host exposes no public fresh-reply frontend action.
// These semantic selectors are centralized here for future host changes.
const INPUT = 'textarea[name="chat-message"]'
export function composer() {
  const input = document.querySelector<HTMLTextAreaElement>(INPUT)
  if (!input) throw new Error('Lumiverse chat input was not found.')
  // In staging the native send shell is the next sibling of the textarea
  // wrapper. The icon identifies the empty-send state independently of locale.
  const button = input.parentElement?.nextElementSibling?.querySelector<HTMLButtonElement>('button[aria-label]')
  const send = button?.querySelector('svg.lucide-send') && !button.disabled ? button : undefined
  return { input, send }
}
export function readDraft() { return composer().input.value }
export function setDraft(value: string) {
  const { input } = composer()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (!setter) throw new Error('Cannot update the native input.')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  // React textarea onChange is driven by the bubbling native input event.
}
export function freshReplyButton(input: HTMLTextAreaElement, draftLabel: string) {
  const current = composer()
  if (current.input !== input || !input.isConnected || input.value !== '' || !current.send) throw new Error('The fresh-reply control is unavailable or the chat draft changed.')
  // The same Send icon covers attachments and pending regex send actions.
  // The accessible label changes only when hasDraftContent becomes false.
  // Comparing against the nonempty draft works in every host locale.
  const label = current.send.getAttribute('aria-label')
  if (!draftLabel || !label || label === draftLabel) throw new Error('Remove pending attachments or selected send actions before using Guide Response.')
  return current.send
}
export async function waitForEmptyComposer(input: HTMLTextAreaElement, draftLabel: string) {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  return freshReplyButton(input, draftLabel)
}
