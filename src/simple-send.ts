import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { composer } from './composer'

// Lumiverse's native Ctrl/Cmd+Send saves through handleQueueMessage. Keep its
// persona, attachment, regex-action, draft and message-store handling intact.
export async function simpleSend(ctx: SpindleFrontendContext, signal: AbortSignal) {
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
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => finish()
    try {
      unsubscribe = ctx.events.on('MESSAGE_SENT', raw => {
        const event = raw as { chatId?: string; message?: { is_user?: boolean } } | null
        if (event?.chatId === chatId && event.message?.is_user === true) finish()
      })
      signal.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(() => finish(new Error('Could not confirm Simple Send. Check the chat history before retrying.')), 15000)
      // Both modifiers select the native save-only path on Windows/Linux/macOS.
      // Never fall back to an ordinary click: it would start a generation.
      current.send!.dispatchEvent(new window.MouseEvent('click', {
        bubbles: true, cancelable: true, button: 0, ctrlKey: true, metaKey: true,
      }))
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Simple Send failed.'))
    }
  })
}
