import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { composer } from './composer'
import { observeNativeSave } from './native-save'
import type { draftRecovery } from './draft-recovery'

// Lumiverse's native Ctrl/Cmd+Send saves through handleQueueMessage. Keep its
// persona, attachment, regex-action, draft and message-store handling intact.
export async function simpleSend(ctx: SpindleFrontendContext, signal: AbortSignal, drafts: ReturnType<typeof draftRecovery>) {
  const chatId = ctx.getActiveChat().chatId
  if (!chatId) throw new Error('Open a chat before sending a message.')
  const { input } = composer()
  const original = input.value
  if (!original.trim()) throw new Error('Type a message first.')
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (signal.aborted) return
  const current = composer()
  if (ctx.getActiveChat().chatId !== chatId || current.input !== input || !input.isConnected || input.value !== original) {
    throw new Error('The active chat or message changed. Send again from the current input.')
  }
  if (!current.send) throw new Error('Wait for the current generation to finish.')
  const savedDraft = drafts.add(chatId, original)
  await observeNativeSave(chatId, original, signal, () => {
    current.send!.dispatchEvent(new window.MouseEvent('click', {
      bubbles: true, cancelable: true, button: 0, ctrlKey: true, metaKey: true,
    }))
  })
  if (!signal.aborted) drafts.remove(savedDraft)
}
