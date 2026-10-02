import { useEffect, useId, useRef, type ReactNode } from 'react'
import { renderEmoji, type FormatContext } from '../format'
import type { User } from '../slack/types'

export function AvatarStatus({ children, user, context }: { children: ReactNode; user: User; context: FormatContext }) {
  const id = useId()
  const badge = useRef<HTMLButtonElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const name = user.statusEmoji?.replace(/^:|:$/g, '') || 'speech_balloon'

  const show = () => {
    clearTimeout(closeTimer.current)
    const panel = overlay.current
    const button = badge.current
    if (!panel || !button) return
    panel.showPopover()
    const bounds = button.getBoundingClientRect()
    panel.style.left = `${Math.max(8, Math.min(bounds.left - 8, window.innerWidth - panel.offsetWidth - 8))}px`
    panel.style.top = `${Math.max(8, bounds.top - 3)}px`
  }
  const hide = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (document.activeElement !== badge.current) overlay.current?.hidePopover()
    }, 120)
  }

  useEffect(() => () => { clearTimeout(closeTimer.current) }, [])

  return <span className="conversation-avatar-status" onMouseEnter={show} onMouseLeave={hide}>
    {children}
    <button ref={badge} type="button" className="conversation-status-badge" aria-label={user.statusText || 'Custom status'} aria-describedby={id}
      onFocus={show} onBlur={hide} onClick={show} onKeyDown={(event) => { if (event.key === 'Escape') { overlay.current?.hidePopover(); event.stopPropagation() } }}>
      {renderEmoji(name, context)}
    </button>
    <div ref={overlay} id={id} className="conversation-status-overlay" role="tooltip" popover="manual">
      {renderEmoji(name, context)}{user.statusText && <span>{user.statusText}</span>}
    </div>
  </span>
}
