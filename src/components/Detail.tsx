import { prepareConversation } from '../cacheConversationResource'
import { Activity, Suspense, use, useDeferredValue, useLayoutEffect, useRef, useState } from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { dmCollection, channelCollection } from '../collections'
import type { InboxItem } from '../slack/types'
import type { View } from '../store'
import { conversationLabel } from '../format'
import { useCurrentItem, useFormatContext } from '../hooks'
import { inboxStore, useStore, isConversationView } from '../store'
import { ConversationIcon } from './Avatar'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { ArrowLeftIcon, CheckIcon, ClockIcon, ExternalIcon, MuteIcon, SwapIcon } from './Icons'

export function Detail() {
  return <Suspense fallback={<section className="detail detail-empty"><p className="muted">Opening conversation…</p></section>}><DeferredDetail /></Suspense>
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
      {!isConversationView(view) && <ConversationDetail key={`${view}:${item?.id}`} item={item} view={view} />}
      {isConversationView(view) && !selected && <ConversationDetail view={view} />}
    </>
  )
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
  const { markDone, saveForLater, toggleMute, recategorize, openInSlack } = inboxStore.getState()

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
      <section className="detail detail-empty">
        <header className="detail-header" />
        <p className="muted">Select a conversation to read it.</p>
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
          <button
            className="icon-button"
            onClick={() => markDone([id])}
            title={view === 'done' ? 'Restore to inbox (E)' : view === 'later' ? 'Complete (E)' : 'Mark done (E)'}
            aria-label={view === 'done' ? 'Restore to inbox' : view === 'later' ? 'Complete' : 'Mark done'}
          >
            {view === 'done' ? <ArrowLeftIcon /> : <CheckIcon />}
          </button>
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
          <button className="icon-button" onClick={openInSlack} title="Open in Slack (U)" aria-label="Open in Slack">
            <ExternalIcon />
          </button>
        </div>
      </header>
      <MessageList item={item} fullHistory={isConversationView(view)} />
      <Composer item={item} />
    </section>
  )
}
