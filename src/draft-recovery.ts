import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { composer, setDraft } from './composer'

type Draft = { id: string; chatId: string; text: string }
const KEY = 'scene-direction:simple-send-drafts'

export function draftRecovery(ctx: SpindleFrontendContext, changed: () => void) {
  let drafts: Draft[] = []
  let dialog: HTMLDialogElement | undefined
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(KEY) || '[]')
    if (Array.isArray(stored)) drafts = stored.filter(d => typeof d?.id === 'string' && typeof d.chatId === 'string' && typeof d.text === 'string')
  } catch { /* Storage availability is checked before every native send. */ }
  function write(next: Draft[]) {
    // If preservation fails (e.g. quota exceeded), do not clear or send input.
    window.sessionStorage.setItem(KEY, JSON.stringify(next))
    drafts = next
    changed()
  }
  function remove(id: string) { write(drafts.filter(d => d.id !== id)) }
  function forChat() { return drafts.filter(d => d.chatId === ctx.getActiveChat().chatId) }
  function close() { dialog?.remove(); dialog = undefined }
  function open() {
    close()
    dialog = document.createElement('dialog')
    dialog.className = 'sd-draft-recovery'
    dialog.setAttribute('aria-label', 'Recover Simple Send draft')
    dialog.style.cssText = 'max-width:560px;width:85%;background:var(--lumiverse-bg,#1b1b1b);color:var(--lumiverse-text);border:1px solid var(--lumiverse-border);border-radius:12px;padding:20px;'
    const style = document.createElement('style')
    style.textContent = '.sd-draft-recovery button { margin:4px; padding:7px 12px; border-radius:8px; border:1px solid var(--lumiverse-border); background:var(--lumiverse-fill); color:inherit; font:inherit; cursor:pointer; } .sd-draft-recovery button:focus-visible { outline:2px solid var(--lumiverse-accent); } .sd-draft-recovery::backdrop { background:#0008; }'
    dialog.append(style)
    const info = document.createElement('p')
    info.textContent = 'Check the chat history before restoring an unconfirmed send. These copies contain text only; reattach files if needed.'
    dialog.append(info)
    for (const draft of forChat()) {
      const entry = document.createElement('section')
      const copy = document.createElement('textarea')
      copy.readOnly = true; copy.value = draft.text; copy.rows = 4
      copy.setAttribute('aria-label', 'Saved draft text')
      copy.style.cssText = 'box-sizing:border-box;width:100%;background:var(--lumiverse-fill);color:inherit;margin:8px 0;'
      const restore = document.createElement('button')
      restore.textContent = 'Restore to input'; restore.type = 'button'
      restore.addEventListener('click', () => {
        try {
          if (ctx.getActiveChat().chatId !== draft.chatId || composer().input.value !== '') throw new Error('Open the original chat with an empty input before restoring. You can also copy the text above.')
          setDraft(draft.text)
          remove(draft.id)
          entry.remove()
          if (!forChat().length) close()
        } catch (error) { window.alert(error instanceof Error ? error.message : 'Could not restore the draft.') }
      })
      const discard = document.createElement('button')
      discard.type = 'button'; discard.textContent = 'Discard copy'
      discard.addEventListener('click', () => {
        try { remove(draft.id); entry.remove(); if (!forChat().length) close() }
        catch { window.alert('Could not remove the saved copy.') }
      })
      entry.append(copy, restore, discard)
      dialog.append(entry)
    }
    const done = document.createElement('button')
    done.type = 'button'; done.textContent = 'Close'; done.addEventListener('click', close)
    dialog.append(done)
    document.body.append(dialog)
    dialog.showModal()
  }
  return {
    add(chatId: string, text: string) {
      const id = crypto.randomUUID()
      write([...drafts, { id, chatId, text }])
      return id
    },
    remove, open,
    count: () => forChat().length,
    destroy: close,
  }
}
