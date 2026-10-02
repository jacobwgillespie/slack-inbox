import { prepareConversation } from '../cacheConversationResource'
import type { ReactNode } from 'react'
import { Activity, Suspense, use, useDeferredValue, useLayoutEffect, useRef, useState } from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { dmCollection, channelCollection } from '../collections'
import type { InboxItem, LaterItem } from '../slack/types'
import type { View } from '../store'
import { conversationLabel } from '../format'
import { useCurrentItem, useFormatContext } from '../hooks'
import { inboxStore, useStore, isConversationView } from '../store'
import { ConversationIcon } from './Avatar'
import { Composer } from './Composer'
import { TypingIndicator } from './TypingIndicator'
import { Toast } from './Toast'
import { MessageList } from './MessageList'
import { ThreadFocus } from './ThreadFocus'
import { ArrowLeftIcon, ClockIcon, CloseIcon, MuteIcon, SwapIcon } from './Icons'

export function Detail() {
  return <Suspense fallback={<section className="detail detail-empty"><p className="muted">Opening conversation…</p><Toast /></section>}><DeferredDetail /></Suspense>
}

function DeferredDetail() {
  const item = useCurrentItem()
  const view = useStore((state) => state.view)
  const selected = useDeferredValue(isConversationView(view) ? item?.id : undefined)
  const [panels, setPanels] = useState<string[]>([])
  const [lastSelected, setLastSelected] = useState<string>()
  let retained = panels
  if (selected !== lastSelected) {
    setLastSelected(selected)
    if (selected) {
      retained = [selected, ...panels.filter((id) => id !== selected)].slice(0, 8)
      setPanels(retained)
    }
  }

  return (
    <>
      {retained.map((id) => (
        <Activity key={id} mode={selected === id ? 'visible' : 'hidden'}>
          <RetainedConversation id={id} active={selected === id} view={view} />
        </Activity>
      ))}
      {view === 'later' && item && <LaterConversation key={item.id} item={item} />}
      {!isConversationView(view) && (view !== 'later' || !item) && <ConversationDetail key={`${view}:${item?.id}`} item={item} view={view} />}
      {isConversationView(view) && !selected && <ConversationDetail view={view} />}
    </>
  )
}

function LaterConversation({ item }: { item: InboxItem }) {
  use(prepareConversation(item.conversation.id))
  const saved = item.messages.find((message) => message.ts === (item as LaterItem).ts)
  const threadTs = saved?.thread_ts && saved.thread_ts !== saved.ts ? saved.thread_ts : undefined
  const [focused, setFocused] = useState(true)
  return <ConversationDetail item={item} view="later" targetTs={threadTs}
    focusedThread={threadTs && focused ? <ThreadFocus item={item as LaterItem} threadTs={threadTs} onClose={() => setFocused(false)} /> : undefined}
    onCloseThread={() => setFocused(false)}
    threadAction={threadTs && !focused ? <button className="button reopen-thread" onClick={() => setFocused(true)}>View saved thread</button> : undefined} />
}

function RetainedConversation({ id, active, view }: { id: string; active: boolean; view: View }) {
  if (active) use(prepareConversation(id))
  const { data } = useLiveQuery({ query: (q) => q.from({ dm: dmCollection }).where(({ dm }) => eq(dm.id, id)), queryKey: [id] })
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: channelCollection }).where(({ channel }) => eq(channel.id, id)), queryKey: [id] })
  const summary = data[0] ?? channels[0]
  const item = summary
  return <ConversationDetail item={item} view={view} />
}

function ConversationDetail({ item, view, targetTs, focusedThread, threadAction, onCloseThread }: { item?: InboxItem; view: View; targetTs?: string; focusedThread?: ReactNode; threadAction?: ReactNode; onCloseThread?: () => void }) {
  const headerRef = useRef<HTMLElement>(null)
  const context = useFormatContext()
  const session = useStore((state) => state.session)
  const reading = useStore((state) => state.mode === 'reading')
  const pending = useStore((state) => isConversationView(view) && state.selectedId !== item?.id)
  const { saveForLater, toggleMute, recategorize } = inboxStore.getState()

  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return
    const update = () => header.parentElement?.style.setProperty('--conversation-header-height', `${header.offsetHeight}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(header)
    return () => observer.disconnect()
  }, [item?.id])

  if (!item) {
    return (
      <section className={`detail detail-empty${view === 'inbox' ? ' detail-empty-inbox' : ''}`}>
        <header className="detail-header" />
        <Toast />
      </section>
    )
  }

  const { id } = item
  const label = conversationLabel(item.conversation, context.users, session)
  const avatar = item.conversation.userId ? context.users[item.conversation.userId]?.avatar : undefined

  return (
    <section className={`detail${reading ? ' reading' : ''}${focusedThread ? ' detail-thread-focused' : ''}`} aria-label="Conversation" aria-busy={pending} inert={pending}>
      <header ref={headerRef} className="detail-header">
        <button
          className="icon-button mobile-back"
          onClick={() => inboxStore.setState({ mode: 'list', threadTarget: undefined })}
          aria-label="Back to conversations"
          title="Back to conversations"
        >
          <ArrowLeftIcon />
        </button>
        <div className="conversation-heading">
          <div className="conversation-pill">
            <ConversationIcon conversation={item.conversation} label={label} avatar={avatar} />
            <h2>{focusedThread ? `Thread in ${label}` : label}</h2>
          </div>
        </div>
        <div className="detail-actions">
          {focusedThread && <button className="icon-button" onClick={onCloseThread} aria-label="Close thread" title="Close (Esc)"><CloseIcon /></button>}
          {view !== 'later' && !isConversationView(view) && (
            <>
              <button
                className="icon-button"
                onClick={() => saveForLater([id])}
                title="Save for later (L)"
                aria-label="Save for later"
              >
                <ClockIcon />
              </button>
              {!item.thread && view !== 'muted' && (
                <button
                  className="icon-button"
                  onClick={() => recategorize([id])}
                  title={`${view === 'important' ? 'Move to Other' : 'Move to Important'} (C)`}
                  aria-label={view === 'important' ? 'Move to Other' : 'Move to Important'}
                >
                  <SwapIcon />
                </button>
              )}
              {!item.thread && (
                <button
                  className="icon-button"
                  onClick={() => toggleMute([id])}
                  title={`${view === 'muted' ? 'Unmute' : 'Mute'} (M)`}
                  aria-label={view === 'muted' ? 'Unmute' : 'Mute'}
                >
                  <MuteIcon />
                </button>
              )}
            </>
          )}
        </div>
      </header>
      <div className="conversation-content" inert={Boolean(focusedThread)} aria-hidden={Boolean(focusedThread)}>
        <MessageList item={item} fullHistory={isConversationView(view) || view === 'later'} targetTs={view === 'later' ? targetTs ?? (item as LaterItem).ts : undefined} />
        <div className="conversation-composer">
          <Toast />
          <TypingIndicator channel={item.conversation.id} />
          <Composer item={item} />
        </div>
      </div>
      {focusedThread}
      {threadAction}
    </section>
  )
}
