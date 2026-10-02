import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { commands } from '../commands'
import { useInboxMuted } from '../data'
import { useStore } from '../store'
import type { InboxItem } from '../slack/types'
import { ArrowLeftIcon, BookmarkIcon, CheckIcon, MuteIcon } from './Icons'

export function ItemContextMenu({ item, x, y, onClose }: { item: InboxItem; x: number; y: number; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null)
  const view = useStore((state) => state.view)
  const muted = useInboxMuted(item.conversation.id)
  useLayoutEffect(() => {
    const panel = menu.current!
    panel.showPopover()
    panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - panel.offsetWidth - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - panel.offsetHeight - 8))}px`
    panel.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [x, y])
  const act = (action: () => void) => { menu.current?.hidePopover(); onClose(); action() }
  const doneLabel = view === 'done' ? 'Unmark done' : 'Mark done'
  return createPortal(
    <div ref={menu} popover="auto" role="menu" aria-label="Thread actions" className="item-context-menu"
      onToggle={(event) => { if (event.newState === 'closed') onClose() }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') { menu.current?.hidePopover(); onClose() }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')]
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
        }
      }}>
      <button role="menuitem" onClick={() => act(() => commands.markDone([item.id]))}>
        {view === 'done' ? <ArrowLeftIcon /> : <CheckIcon />}<span>{doneLabel}</span>
      </button>
      {view === 'inbox' && <button role="menuitem" onClick={() => act(() => commands.saveForLater([item.id]))}>
        <BookmarkIcon /><span>Save for later</span>
      </button>}
      <hr />
      <button role="menuitem" onClick={() => act(() => commands.toggleInboxMute(item))}>
        <MuteIcon /><span>{muted ? 'Unmute thread' : 'Mute thread'}</span>
      </button>
    </div>, document.body,
  )
}
