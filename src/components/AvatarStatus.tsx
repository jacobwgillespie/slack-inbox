import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { renderEmoji, type FormatContext } from '../format'
import type { User } from '../slack/types'

export function AvatarStatus({ children, user, context }: { children: ReactNode; user: User; context: FormatContext }) {
  const id = useId()
  const badge = useRef<HTMLButtonElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const name = user.statusEmoji?.replace(/^:|:$/g, '') || 'speech_balloon'

  const show = () => {
    clearTimeout(closeTimer.current)
    const panel = overlay.current
    const button = badge.current
    if (!panel || !button) return
    const bounds = button.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(bounds.left - 8, window.innerWidth - panel.offsetWidth - 8)),
      top: Math.max(8, bounds.top - 3),
    })
  }
  const hide = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      if (document.activeElement !== badge.current) setPosition(undefined)
    }, 120)
  }

  useEffect(() => () => { clearTimeout(closeTimer.current) }, [])

  return <span className="conversation-avatar-status" onMouseEnter={show} onMouseLeave={hide}>
    {children}
    <button ref={badge} type="button" className="conversation-status-badge" aria-label={user.statusText || 'Custom status'} aria-describedby={id}
      onFocus={show} onBlur={hide} onClick={show} onKeyDown={(event) => { if (event.key === 'Escape') { setPosition(undefined); event.stopPropagation() } }}>
      {renderEmoji(name, context)}
    </button>
    {createPortal(<div ref={overlay} id={id} className={`conversation-status-overlay${position ? ' is-visible' : ''}`} role="tooltip"
      aria-hidden={!position} style={position}>
      {renderEmoji(name, context)}{user.statusText && <span>{user.statusText}</span>}
    </div>, document.body)}
  </span>
}
