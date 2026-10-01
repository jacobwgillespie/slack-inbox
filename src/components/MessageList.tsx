import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isSameAuthorGroup } from '../format'
import type { InboxItem, Message } from '../slack/types'
import { useStore } from '../store'
import { useTimestampReveal } from '../useTimestampReveal'
import { useWebviewConversation } from '../useWebviewConversation'
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
  const fromWebview = dms && Boolean(window.slackDesktop)
  const webview = useWebviewConversation(item.id, fromWebview)
  const history = useStore((state) => state.histories[item.id])
  const loadHistory = useStore((state) => state.loadHistory)
  const ref = useRef<HTMLDivElement>(null)
  const olderRef = useRef<HTMLDivElement>(null)
  const automaticBefore = useRef<string | undefined>(undefined)
  const revealRef = useRef<HTMLDivElement>(null)
  useTimestampReveal(revealRef)
  const position = useRef<{ top: number; atBottom: boolean; anchor?: { ts: string; offset: number } }>({ top: 0, atBottom: true })
  const [atBottom, setAtBottom] = useState(true)

  useEffect(() => {
    if (!dms || fromWebview) return
    void loadHistory(item.id)
    const timer = setInterval(() => void loadHistory(item.id), 60 * 1000)
    return () => clearInterval(timer)
  }, [dms, fromWebview, item.id, loadHistory])

  const messages = fromWebview ? webview.snapshot?.messages ?? [] : dms && !history?.item ? [] : item.messages

  const rememberPosition = (element: HTMLDivElement) => {
    if (!element.clientHeight) return
    const top = element.getBoundingClientRect().top
    const row = [...element.querySelectorAll<HTMLElement>('[data-message-ts]')].find((row) => row.getBoundingClientRect().bottom > top)
    position.current = {
      ...position.current, top: element.scrollTop,
      anchor: row?.dataset.messageTs ? { ts: row.dataset.messageTs, offset: row.getBoundingClientRect().top - top } : undefined,
    }
  }

  const restorePosition = (element: HTMLDivElement) => {
    if (!element.clientHeight) return
    if (position.current.atBottom) {
      element.scrollTop = element.scrollHeight
    } else {
      const anchor = position.current.anchor
      const row = anchor && element.querySelector<HTMLElement>(`[data-message-ts="${CSS.escape(anchor.ts)}"]`)
      if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
      else element.scrollTop = position.current.top
    }
    rememberPosition(element)
  }

  useLayoutEffect(() => {
    if (ref.current && dms) restorePosition(ref.current)
  }, [dms, messages, history?.loading])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !dms) return
    restorePosition(element)
    const observer = new ResizeObserver(() => restorePosition(element))
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [dms])

  const showEarlier = () => {
    if (!webview.snapshot?.hasMore || webview.loadingOlder || webview.error) return
    if (ref.current) {
      position.current.atBottom = false
      rememberPosition(ref.current)
    }
    webview.scroll('older')
  }

  // Observe the top of our timeline, rather than depending on wheel input.
  // Recheck after prepending messages in case the viewport is still near it.
  useEffect(() => {
    const element = ref.current
    const sentinel = olderRef.current
    if (!fromWebview || !element || !sentinel || webview.loadingOlder || !webview.snapshot?.hasMore || webview.error) return
    const observer = new IntersectionObserver(([entry]) => {
      const first = messages[0]?.ts
      if (entry?.isIntersecting && first && automaticBefore.current !== first) {
        automaticBefore.current = first
        showEarlier()
      }
    }, { root: element, rootMargin: '200px 0px 0px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [fromWebview, messages[0]?.ts, webview.loadingOlder, webview.snapshot?.hasMore, webview.error])

  const scrollToLatest = () => {
    if (fromWebview) webview.scroll('latest')
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }

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
            onWheel={(event) => {
              if (fromWebview && event.deltaY < 0 && event.currentTarget.scrollTop < 200) showEarlier()
            }}
            onScroll={(event) => {
              const element = event.currentTarget
              if (!element.clientHeight) return
              const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
              position.current.atBottom = bottom
              rememberPosition(element)
              setAtBottom(bottom)
              if (fromWebview && element.scrollTop < 200) showEarlier()
              if (!fromWebview && dms && element.scrollTop < 80 && history?.item && history.hasMore && !history.loading && !history.error) {
                void loadHistory(item.id, 'older')
              }
            }}
          >
            <div className="message-track">
              {fromWebview && <div ref={olderRef} aria-hidden="true" />}
              {dms && !fromWebview && (
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
              {fromWebview && (
                <div className="history-status" role="status">
                  {webview.error ? <span className="scan-error">{webview.error}</span> : !webview.snapshot ? 'Reading Slack webview…' : (
                    <span>{webview.loadingOlder ? 'Loading earlier messages…' : !webview.snapshot.hasMore ? 'Beginning of conversation' : `From Slack webview · ${messages.length} observed messages`}</span>
                  )}
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
                      webview={fromWebview}
                      channel={item.conversation.id}
                      message={message}
                      continued={sameGroup(previous, message)}
                      continues={Boolean(messages[index + 1] && sameGroup(message, messages[index + 1]!))}
                    />
                  </Fragment>
                )
              })}
              {dms && !fromWebview && history?.item && !item.messages.length && <p className="conversation-empty muted">No messages in this conversation yet.</p>}
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
