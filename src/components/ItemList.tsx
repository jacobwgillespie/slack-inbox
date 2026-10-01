import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { conversationLabel, formatListTime, messageSummary, authorName } from '../format'
import { useFormatContext, useVisibleItems, useViewCounts } from '../hooks'
import { inboxStore, latestTs, mentionsSelf, isConversationView, useStore, type View } from '../store'
import { compareTs } from '../slack/timestamps'
import type { InboxItem } from '../slack/types'
import { ConversationIcon } from './Avatar'
import { useTyping } from '../typing'
import { TypingDots } from './TypingIndicator'
import { ArrowLeftIcon, CheckIcon, ClockIcon, MuteIcon } from './Icons'

const EMPTY_STATES: Record<View, { title: string; detail: string }> = {
  important: { title: 'All caught up', detail: 'No unread direct messages or mentions.' },
  other: { title: 'Nothing else unread', detail: 'Every channel is read.' },
  later: { title: 'Nothing saved', detail: 'Save a message for later using its bookmark button, or move a conversation to Later.' },
  muted: { title: 'No muted unreads', detail: 'Muted conversations with unread messages appear here.' },
  done: { title: 'Nothing done yet', detail: 'Press E on a DM or channel to mark it done.' },
  inbox: { title: 'Inbox is empty', detail: 'Your Slack channels and direct messages will appear here after syncing.' },
}

export function ItemList() {
  const items = useVisibleItems()
  const counts = useViewCounts()
  const view = useStore((state) => state.view)
  const status = useStore((state) => state.status)
  const selected = useStore((state) => state.selectedId)
  const listRef = useRef<HTMLElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const [moreBelow, setMoreBelow] = useState(false)
  useLayoutEffect(() => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('li[aria-selected="true"]')
    if (!list || !row) return
    const previous = row.previousElementSibling
    const next = row.nextElementSibling
    if (!previous) {
      list.scrollTop = 0
    } else if (!next) {
      list.scrollTop = list.scrollHeight - list.clientHeight
    } else {
      // Keep a neighboring row visible between the selection and either fade.
      const bounds = list.getBoundingClientRect()
      const top = previous.getBoundingClientRect().top - 8
      const bottom = next.getBoundingClientRect().bottom + 8
      if (top < bounds.top) list.scrollTop += top - bounds.top
      else if (bottom > bounds.bottom) list.scrollTop += bottom - bounds.bottom
    }
  }, [selected, view])
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const update = () => {
      setScrolled(list.scrollTop > 0)
      setMoreBelow(list.scrollHeight - list.clientHeight - list.scrollTop > 1)
    }
    update()
    list.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(list)
    const content = list.querySelector('ul')
    if (content) observer.observe(content)
    return () => {
      list.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [view, items.length])
  useEffect(() => {
    const bridge = window.slackDesktop
    const list = listRef.current
    if (!bridge || !list || !isConversationView(view)) return
    const visible = new Set<string>()
    let timer: ReturnType<typeof setTimeout>
    const watch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void bridge.watchConversations([...visible], selected).catch(console.error), 80)
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.conversationId!
        if (entry.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      watch()
    }, { root: list, rootMargin: '150px 0px' })
    for (const row of list.querySelectorAll('[data-conversation-id]')) observer.observe(row)
    return () => { clearTimeout(timer); observer.disconnect(); void bridge.watchConversations([]).catch(console.error) }
  }, [view, selected, items.map((item) => item.id).join(',')])

  if (!items.length) {
    const empty = view === 'inbox' && (counts.later > 0 || counts.done > 0)
      ? { title: 'Everything is handled', detail: 'New activity will appear here.' }
      : EMPTY_STATES[view]
    return (
      <section ref={listRef} className="item-list item-list-empty">
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
    <section ref={listRef} className={`item-list${scrolled ? ' scrolled' : ''}${moreBelow ? ' more-below' : ''}`} aria-label="Conversations" tabIndex={-1}>
      <ul>
        {items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

function ItemRow({ item }: { item: InboxItem }) {
  const { id } = item
  const typing = useTyping(item.conversation.id)
  const context = useFormatContext()
  const session = useStore((state) => state.session)
  const view = useStore((state) => state.view)
  const selected = useStore((state) => state.selectedId === id)
  const checked = useStore((state) => Boolean(state.checked[id]))
  const reading = useStore((state) => state.mode === 'reading')
  const conversation = useStore((state) => state.directMessages[id] ?? state.channels[id])
  const { select, open, markDone, saveForLater, toggleMute, toggleChecked } = inboxStore.getState()

  const latest = item.messages[item.messages.length - 1]
  const label = conversationLabel(item.conversation, context.users, session)
  const avatar = item.conversation.userId ? context.users[item.conversation.userId]?.avatar : undefined
  const mentioned = item.conversation.kind !== 'dm' && mentionsSelf(item, session)
  const unread = isConversationView(view) && conversation && compareTs(conversation.latestTs, conversation.lastRead ?? '0') > 0

  const onClick = (event: MouseEvent) => {
    event.currentTarget.closest<HTMLElement>('.item-list')?.focus({ preventScroll: true })
    if (event.metaKey || event.ctrlKey || event.shiftKey) toggleChecked(id)
    else if (isConversationView(view) || (selected && !reading)) open(id)
    else select(id)
  }

  const action = (handler: (ids: string[]) => void) => (event: MouseEvent) => {
    event.stopPropagation()
    handler([id])
  }

  const className = ['item-row', selected && 'selected', checked && 'checked'].filter(Boolean).join(' ')
  const doneLabel = view === 'done' ? 'Restore to inbox' : view === 'later' ? 'Complete' : 'Mark done'

  return (
    <li data-conversation-id={id} className={className} onClick={onClick} onDoubleClick={() => open(id)} aria-selected={selected}>
      <button
        className="done-button"
        title={`${doneLabel} (E)`}
        aria-label={`${doneLabel}: ${label}`}
        onClick={action((ids) => markDone(ids))}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {view === 'done' ? <ArrowLeftIcon /> : <CheckIcon />}
      </button>
      {view === 'inbox' && (
        <button
          className="done-button later-button"
          title="Move to Later (L)"
          aria-label={`Move to Later: ${label}`}
          onClick={action((ids) => saveForLater(ids))}
          onDoubleClick={(event) => event.stopPropagation()}
        ><ClockIcon /></button>
      )}
      <ConversationIcon conversation={item.conversation} label={label} avatar={avatar} />
      <div className="item-body">
        <div className="item-heading">
          <span className="item-title">{label}</span>
          {unread && <span className="unread-dot" aria-label="Unread" />}
          {!isConversationView(view) && item.messages.length > 1 && <span className="item-count">{item.messages.length}</span>}
          {item.thread && <span className="item-flag item-flag-thread">Thread</span>}
          {mentioned && <span className="item-flag">Mention</span>}
          <time className="item-time">{latestTs(item) !== '0' && formatListTime(latestTs(item))}</time>
        </div>
        {item.thread && (
          <p className="item-context">
            {authorName(item.thread.root, context.users)}: {messageSummary(item.thread.root, context)}
          </p>
        )}
        {typing.length > 0 ? <p className="item-preview"><TypingDots /></p> : latest ? (
          <p className="item-preview">
            {item.conversation.kind !== 'dm' && <span className="item-author">{authorName(latest, context.users)}: </span>}
            {messageSummary(latest, context)}
          </p>
        ) : isConversationView(view) ? <p className="item-preview">Open conversation</p> : null}
      </div>
      <div className="item-actions">
        {view !== 'later' && !isConversationView(view) && (
          <>
            <button title="Save for later (L)" onClick={action(saveForLater)}>
              <ClockIcon />
            </button>
            {!item.thread && (
              <button title={view === 'muted' ? 'Unmute (M)' : 'Mute (M)'} onClick={action(toggleMute)}>
                <MuteIcon />
              </button>
            )}
          </>
        )}
      </div>
    </li>
  )
}
