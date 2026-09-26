import type { SpindleFrontendContext, SpindleInputBarActionHandle } from 'lumiverse-spindle-types'
import { GUIDE_ICON, SIMPLE_ICON } from './action-icons'
import { composer } from './composer'

export function composerActions(ctx: SpindleFrontendContext, state: () => { ready: boolean; busy: boolean }, guide: () => void, simple: () => void) {
  let handles: SpindleInputBarActionHandle[] = []
  let enabled: boolean[] = []
  let disposed = false
  function allowed(index: number) {
    if (disposed || handles.length !== 2) return false
    const { ready, busy } = state()
    try {
      const current = composer()
      return !busy && (index !== 0 || ready) && Boolean(current.send && current.input.value.trim())
    } catch { return false }
  }
  function remove() {
    const previous = handles
    handles = []
    enabled = []
    for (const handle of previous) handle.destroy()
  }
  return {
    active: () => handles.length === 2,
    setActive(active: boolean) {
      if (disposed || active === (handles.length === 2)) return
      if (!active) { remove(); return }
      try {
        for (const [index, action] of [
          { id: 'scene_direction.guide', label: 'Guide Response', subtitle: 'Use the draft as a temporary scene direction for the next reply.', iconSvg: GUIDE_ICON },
          { id: 'scene_direction.simple_send', label: 'Simple Send', subtitle: 'Save the draft as a user message without generating a reply.', iconSvg: SIMPLE_ICON },
        ].entries()) {
          const handle = ctx.ui.registerInputBarAction({ ...action, enabled: false })
          handles.push(handle)
          enabled.push(false)
          handle.onClick(() => { if (handles[index] === handle && allowed(index)) (index === 0 ? guide : simple)() })
        }
      } catch (error) {
        remove()
        throw error
      }
    },
    refresh() {
      handles.forEach((handle, index) => {
        const available = allowed(index)
        if (enabled[index] !== available) {
          enabled[index] = available
          handle.setEnabled(available)
        }
        // Quick Toolbar currently ignores InputBarAction.enabled, although Extras
        // respects it. Decorate only our registered composer buttons and guard
        // callbacks on every surface. Never override the host's visibility/order.
        for (const slot of Array.from(document.querySelectorAll('[data-composer-action]'))) {
          if (!slot.getAttribute('data-composer-action')?.endsWith(`:${handle.actionId}`)) continue
          const button = slot.querySelector('button')
          if (button && button.disabled !== !available) button.disabled = !available
        }
      })
    },
    destroy() { disposed = true; remove() },
  }
}
