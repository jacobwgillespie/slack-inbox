import { useRuntime } from '../data'
import { commands } from '../commands'
import { prepareConversation } from '../cacheConversationResource'
import { Activity, Suspense, use, useDeferredValue, useLayoutEffect, useRef, useState } from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { dmCollection, channelCollection, inboxCollection } from '../collections'
import type { InboxItem, LaterItem } from '../slack/types'
import type { View } from '../store'
import { conversationLabel, renderEmoji } from '../format'
import { useCurrentItem, useFormatContext, useInboxEmpty } from '../hooks'
import { inboxStore, useStore, isConversationView } from '../store'
import { ConversationIcon } from './Avatar'
import { PresenceDot } from './PresenceDot'
import { usePresence } from '../presence'
import { useCustomStatus } from '../custom-status'
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
      {view === 'later' && item && <LoadedConversation key={item.id} item={item} view={view} />}
      {!isConversationView(view) && (view !== 'later' || !item) && <LoadedConversation key={`${view}:${item?.id}`} item={item} view={view} />}
      {isConversationView(view) && !selected && <ConversationDetail view={view} />}
    </>
  )
}

function LoadedConversation({ item, view }: { item?: InboxItem; view: View }) {
  if (item) use(prepareConversation(item.conversation.id))
  return <ConversationDetail item={item} view={view} />
}

function RetainedConversation({ id, active, view }: { id: string; active: boolean; view: View }) {
  const { data } = useLiveQuery({ query: (q) => q.from({ dm: dmCollection }).where(({ dm }) => eq(dm.id, id)), queryKey: [id] })
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: channelCollection }).where(({ channel }) => eq(channel.id, id)), queryKey: [id] })
  const { data: threads } = useLiveQuery({ query: (q) => q.from({ thread: inboxCollection }).where(({ thread }) => eq(thread.id, id)), queryKey: [id] })
  const item = data[0] ?? channels[0] ?? threads[0]
  if (active && item) use(prepareConversation(item.conversation.id))
  return <ConversationDetail item={item} view={view} />
}

function ConversationDetail({ item, view }: { item?: InboxItem; view: View }) {
  const headerRef = useRef<HTMLElement>(null)
  const openedThread = useStore((state) => state.focusedThread)
  const selectedId = useStore((state) => state.selectedId)
  const presence = usePresence(selectedId === item?.id && item?.conversation.kind === 'dm' ? item.conversation.userId : undefined)
  const [dismissedThread, setDismissedThread] = useState<string>()
  const savedTs = view === 'later' ? (item as LaterItem | undefined)?.ts : undefined
  const saved = item?.messages.find((message) => message.ts === savedTs)
  const automaticThread = item?.thread?.ts ?? (saved?.thread_ts !== saved?.ts ? saved?.thread_ts : undefined)
  const threadTs = selectedId === item?.id && openedThread?.channel === item?.conversation.id
    ? openedThread?.ts : automaticThread !== dismissedThread ? automaticThread : undefined
  const onCloseThread = () => {
    setDismissedThread(automaticThread)
    inboxStore.setState({ focusedThread: undefined, threadTarget: undefined })
  }
  const focusedThread = item && threadTs ? <ThreadFocus key={`${item.conversation.id}:${threadTs}`} item={item} threadTs={threadTs} savedTs={savedTs} onClose={onCloseThread} /> : undefined

  const context = useFormatContext()
  const dmUser = item?.conversation.kind === 'dm' ? context.users[item.conversation.userId ?? ''] : undefined
  const hasStatus = useCustomStatus(dmUser)
  const { session } = useRuntime()
  const reading = useStore((state) => state.mode === 'reading')
  const pending = useStore((state) => isConversationView(view) && state.selectedId !== item?.id)
  const inboxEmpty = useInboxEmpty()
  const { saveForLater, toggleMute, recategorize } = commands

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
      <section className={`detail detail-empty${view === 'inbox' && inboxEmpty ? ' detail-empty-inbox' : ''}`}>
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
            <div className="conversation-pill-label">
              <div className="conversation-pill-name">
                <h2>{focusedThread ? `Thread in ${label}` : label}</h2>
                {item.conversation.kind === 'dm' && <PresenceDot presence={presence} />}
              </div>
              {hasStatus && <div className="conversation-status" title={dmUser?.statusText || 'Custom status'}>
                {dmUser?.statusEmoji && renderEmoji(dmUser.statusEmoji.replace(/^:|:$/g, ''), context)}
                {dmUser?.statusText && <span>{dmUser.statusText}</span>}
              </div>}
            </div>
          </div>
        </div>
        <div className="detail-actions">
          {focusedThread && <button className="icon-button" onClick={onCloseThread} aria-label="Close thread" title="Close (Esc)"><CloseIcon /></button>}
          {!focusedThread && view !== 'later' && !isConversationView(view) && (
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
        <MessageList item={item} fullHistory={isConversationView(view) || view === 'later' || Boolean(item.thread)} targetTs={automaticThread ?? savedTs} />
        <div className="conversation-composer">
          <Toast />
          <TypingIndicator channel={item.conversation.id} />
          <Composer item={item} />
        </div>
      </div>
      {focusedThread}
      {automaticThread && !focusedThread && <button className="button reopen-thread" onClick={() => setDismissedThread(undefined)}>View thread</button>}
    </section>
  )
}
