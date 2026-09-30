import { useEffect, useRef, type MouseEvent } from 'react'
import { conversationLabel, formatListTime, messageSummary, authorName } from '../format'
import { useFormatContext, useVisibleItems } from '../hooks'
import { latestTs, mentionsSelf, useStore, type View } from '../store'
import type { InboxItem } from '../slack/types'
import { ConversationIcon } from './Avatar'
import { CheckIcon, ClockIcon, MuteIcon } from './Icons'

const EMPTY_STATES: Record<View, { title: string; detail: string }> = {
  important: { title: 'All caught up', detail: 'No unread direct messages or mentions.' },
  other: { title: 'Nothing else unread', detail: 'Every channel is read.' },
  later: { title: 'Nothing saved', detail: 'Press L on a conversation to keep it here.' },
  muted: { title: 'No muted unreads', detail: 'Muted conversations with unread messages appear here.' },
}

export function ItemList() {
  const items = useVisibleItems()
  const view = useStore((state) => state.view)
  const status = useStore((state) => state.status)

  if (!items.length) {
    const empty = EMPTY_STATES[view]
    return (
      <section className="item-list item-list-empty">
        {status === 'loading' ? (
          <p className="muted">Loading conversations…</p>
        ) : (
          <>
            <h2>{empty.title}</h2>
            <p className="muted">{empty.detail}</p>
          </>
        )}
      </section>
    )
  }

  return (
    <section className="item-list" aria-label="Conversations">
      <ul>
        {items.map((item) => (
          <ItemRow key={item.conversation.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function ItemRow({ item }: { item: InboxItem }) {
  const { id } = item.conversation
  const context = useFormatContext()
  const session = useStore((state) => state.session)
  const view = useStore((state) => state.view)
  const selected = useStore((state) => state.selectedId === id)
  const checked = useStore((state) => Boolean(state.checked[id]))
  const reading = useStore((state) => state.mode === 'reading')
  const { select, open, markDone, saveForLater, toggleMute, toggleChecked } = useStore.getState()
  const ref = useRef<HTMLLIElement>(null)

  const latest = item.messages[item.messages.length - 1]
  const label = conversationLabel(item.conversation, context.users, session)
  const avatar = item.conversation.userId ? context.users[item.conversation.userId]?.avatar : undefined
  const mentioned = item.conversation.kind !== 'dm' && mentionsSelf(item, session)

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const onClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) toggleChecked(id)
    else if (selected && !reading) open(id)
    else select(id)
  }

  const action = (handler: (ids: string[]) => void) => (event: MouseEvent) => {
    event.stopPropagation()
    handler([id])
  }

  const className = ['item-row', selected && 'selected', checked && 'checked'].filter(Boolean).join(' ')

  return (
    <li ref={ref} className={className} onClick={onClick} onDoubleClick={() => open(id)} aria-selected={selected}>
      <button
        className="done-button"
        title={view === 'later' ? 'Remove from Later (E)' : 'Mark as read (E)'}
        onClick={action((ids) => markDone(ids))}
      >
        <CheckIcon />
      </button>
      <ConversationIcon conversation={item.conversation} label={label} avatar={avatar} />
      <div className="item-body">
        <div className="item-heading">
          <span className="item-title">{label}</span>
          {item.messages.length > 1 && <span className="item-count">{item.messages.length}</span>}
          {mentioned && <span className="item-flag">Mention</span>}
          <time className="item-time">{formatListTime(latestTs(item))}</time>
        </div>
        {latest && (
          <p className="item-preview">
            {item.conversation.kind !== 'dm' && <span className="item-author">{authorName(latest, context.users)}: </span>}
            {messageSummary(latest, context)}
          </p>
        )}
      </div>
      <div className="item-actions">
        {view !== 'later' && (
          <>
            <button title="Save for later (L)" onClick={action(saveForLater)}>
              <ClockIcon />
            </button>
            <button title={view === 'muted' ? 'Unmute (M)' : 'Mute (M)'} onClick={action(toggleMute)}>
              <MuteIcon />
            </button>
          </>
        )}
      </div>
    </li>
  )
}
