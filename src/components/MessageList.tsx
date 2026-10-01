import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isSameAuthorGroup } from '../format'
import { compareTs } from '../slack/timestamps'
import type { InboxItem, Message } from '../slack/types'
import { useStore } from '../store'
import { useTimestampReveal } from '../useTimestampReveal'
import { MessageView } from './Message'
import { ArrowUpIcon } from './Icons'

function messageDay(ts: string): string {
  const date = new Date(Number(ts) * 1000)
  const today = new Date()
  const currentYear = today.getFullYear()
  if (date.toDateString() === today.toDateString()) return 'Today'
  today.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: date.getFullYear() === currentYear ? undefined : 'numeric',
  })
}

export function MessageList({ item, dms }: { item: InboxItem; dms: boolean }) {
  const history = useStore((state) => state.histories[item.id])
  const loadHistory = useStore((state) => state.loadHistory)
  const ref = useRef<HTMLDivElement>(null)
  const revealRef = useRef<HTMLDivElement>(null)
  useTimestampReveal(revealRef)
  const position = useRef({ first: '', height: 0, top: 0, atBottom: true })
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    if (!dms) return
    void loadHistory(item.id)
    const timer = setInterval(() => void loadHistory(item.id), 60 * 1000)
    return () => clearInterval(timer)
  }, [dms, item.id, loadHistory])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !dms) return
    const previous = position.current
    const first = item.messages[0]?.ts ?? ''
    if (previous.first && first && compareTs(first, previous.first) < 0) {
      element.scrollTop = previous.top + element.scrollHeight - previous.height
    } else if (previous.atBottom) {
      element.scrollTop = element.scrollHeight
    } else {
      element.scrollTop = previous.top
    }
    position.current = { first, height: element.scrollHeight, top: element.scrollTop, atBottom: previous.atBottom }
  }, [dms, item.messages, history?.loading])

  useEffect(() => {
    const element = ref.current
    if (!element || !dms) return
    element.scrollTop = position.current.atBottom ? element.scrollHeight : position.current.top
    const observer = new ResizeObserver(() => {
      if (position.current.atBottom) element.scrollTop = element.scrollHeight
      position.current = { ...position.current, height: element.scrollHeight, top: element.scrollTop }
    })
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [dms])

  const scrollToLatest = () => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }

  const messages = dms && !history?.item ? [] : item.messages

  const sameGroup = (previous: Message | undefined, message: Message) =>
    Boolean(previous && messageDay(previous.ts) === messageDay(message.ts) &&
      isSameAuthorGroup(previous, message, dms ? Infinity : undefined))

  return (
    <div className="timeline">
      <div ref={revealRef} className="timestamp-scroll">
        <div className="timestamp-track">
          <div
            ref={ref}
            className="message-list"
            onScroll={(event) => {
              const element = event.currentTarget
              if (position.current.atBottom && element.scrollHeight !== position.current.height) {
                element.scrollTop = element.scrollHeight
              }
              const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
              position.current = { ...position.current, top: element.scrollTop, height: element.scrollHeight, atBottom: bottom }
              setAtBottom(bottom)
              if (dms && element.scrollTop < 80 && history?.item && history.hasMore && !history.loading && !history.error) {
                void loadHistory(item.id, 'older')
              }
            }}
          >
            <div className="message-track">
              {dms && (
                <div className="history-status" role="status">
                  {history?.error ? (
                    <>
                      <span className="scan-error">{history.error}</span>
                      <button className="link-button" onClick={() => void loadHistory(item.id, history.loadingOlder ? 'older' : 'latest')}>Retry</button>
                    </>
                  ) : !history?.item ? (
                    <span>Loading conversation…</span>
                  ) : history.hasMore ? (
                    <button className="link-button" disabled={history.loading} onClick={() => void loadHistory(item.id, 'older')}>
                      {history.loading && history.loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
                    </button>
                  ) : <span>Beginning of conversation</span>}
                </div>
              )}
              {item.thread && (
                <>
                  <MessageView channel={item.conversation.id} message={item.thread.root} continued={false} />
                  <div className="thread-divider">{item.messages.length} new {item.messages.length === 1 ? 'reply' : 'replies'}</div>
                </>
              )}
              {messages.map((message, index) => {
                const previous = messages[index - 1]
                return (
                  <Fragment key={message.ts}>
                    {(!previous || messageDay(previous.ts) !== messageDay(message.ts)) && (
                      <div className="date-divider">{messageDay(message.ts)}</div>
                    )}
                    <MessageView
                      channel={item.conversation.id}
                      message={message}
                      continued={sameGroup(previous, message)}
                      continues={Boolean(messages[index + 1] && sameGroup(message, messages[index + 1]!))}
                    />
                  </Fragment>
                )
              })}
              {dms && history?.item && !item.messages.length && <p className="conversation-empty muted">No messages in this conversation yet.</p>}
            </div>
          </div>
        </div>
      </div>
      {dms && !atBottom && (
        <button className="jump-to-latest button" onClick={scrollToLatest} aria-label="Scroll to latest messages" title="Scroll to latest messages">
          <ArrowUpIcon />
        </button>
      )}
    </div>
  )
}
