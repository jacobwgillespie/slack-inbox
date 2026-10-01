import { prepareConversation } from '../cacheConversationResource'
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
import { ArrowLeftIcon, ClockIcon, MuteIcon, SwapIcon } from './Icons'

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
  if (window.slackDesktop) use(prepareConversation(item.conversation.id))
  return <ConversationDetail item={item} view="later" />
}

function RetainedConversation({ id, active, view }: { id: string; active: boolean; view: View }) {
  if (active && window.slackDesktop) use(prepareConversation(id))
  const { data } = useLiveQuery({ query: (q) => q.from({ dm: dmCollection }).where(({ dm }) => eq(dm.id, id)), queryKey: [id] })
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: channelCollection }).where(({ channel }) => eq(channel.id, id)), queryKey: [id] })
  const history = useStore((state) => state.histories[id]?.item)
  const summary = data[0] ?? channels[0]
  const item = window.slackDesktop ? summary : history ?? summary
  return <ConversationDetail item={item} view={view} />
}

function ConversationDetail({ item, view }: { item?: InboxItem; view: View }) {
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
    <section className={`detail${reading ? ' reading' : ''}`} aria-label="Conversation" aria-busy={pending} inert={pending}>
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
            <h2>{label}</h2>
          </div>
        </div>
        <div className="detail-actions">
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
      <MessageList item={item} fullHistory={isConversationView(view) || view === 'later'} targetTs={view === 'later' ? (item as LaterItem).ts : undefined} />
      <div className="conversation-composer">
        <Toast />
        <TypingIndicator channel={item.conversation.id} />
        <Composer item={item} />
      </div>
    </section>
  )
}
