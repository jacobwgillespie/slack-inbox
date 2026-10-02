import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { compareTs } from '../slack/timestamps'
import { isSameAuthorGroup } from '../format'
import type { InboxItem, Message } from '../slack/types'
import { useTimestampReveal } from '../useTimestampReveal'
import { useCachedConversation } from '../useCachedConversation'
import { useReadAtBottom } from '../useReadAtBottom'
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

export function MessageList({ item, fullHistory, targetTs }: { item: InboxItem; fullHistory: boolean; targetTs?: string }) {
  const channel = item.conversation.id
  const jumped = useRef(false)
  const webview = useCachedConversation(channel, fullHistory)
  const ref = useRef<HTMLDivElement>(null)
  const olderRef = useRef<HTMLDivElement>(null)
  const automaticBefore = useRef<string | undefined>(undefined)
  const revealRef = useRef<HTMLDivElement>(null)
  useTimestampReveal(revealRef)
  const position = useRef<{ top: number; atBottom: boolean; anchor?: { ts: string; offset: number } }>({ top: 0, atBottom: true })
  const [atBottom, setAtBottom] = useState(true)

  const conversationMessages = fullHistory ? webview.snapshot?.messages.filter((message) => !message.thread_ts || message.thread_ts === message.ts || message.subtype === 'thread_broadcast') ?? [] : item.messages
  const reachedTarget = targetTs && ((conversationMessages[0] && compareTs(conversationMessages[0].ts, targetTs) <= 0) || (webview.snapshot && !webview.snapshot.hasMore))
  const messages = targetTs && reachedTarget && !conversationMessages.some((message) => message.ts === targetTs)
    ? [...conversationMessages, ...item.messages.filter((message) => message.ts === targetTs && (!message.thread_ts || message.thread_ts === message.ts || message.subtype === 'thread_broadcast'))].sort((a, b) => compareTs(a.ts, b.ts))
    : conversationMessages
  useReadAtBottom(ref, channel, messages.at(-1)?.ts, atBottom, fullHistory && (!targetTs || jumped.current))

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
    const element = ref.current
    if (!element || !fullHistory) return
    if (targetTs && !jumped.current) {
      const row = element.querySelector<HTMLElement>(`[data-message-ts="${CSS.escape(targetTs)}"]`)
      if (!row) return
      jumped.current = true
      position.current.atBottom = false
      row.classList.add('saved-message')
      element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientHeight / 2 + row.offsetHeight / 2
      rememberPosition(element)
      setAtBottom(false)
    } else restorePosition(element)
  }, [fullHistory, messages, targetTs])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !fullHistory) return
    if (!targetTs || jumped.current) restorePosition(element)
    const observer = new ResizeObserver(() => { if (!targetTs || jumped.current) restorePosition(element) })
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  }, [fullHistory, targetTs])

  const showEarlier = () => {
    if (!webview.snapshot?.hasMore || webview.loadingOlder) return
    if (ref.current) {
      position.current.atBottom = false
      rememberPosition(ref.current)
    }
    webview.scroll('older')
  }

  useEffect(() => {
    if (!targetTs || jumped.current || !messages.length || reachedTarget) return
    if (fullHistory) {
      if (!webview.loadingOlder && !webview.error) showEarlier()
    }
  }, [targetTs, messages, reachedTarget, fullHistory, webview.loadingOlder, webview.error])

  // Observe the top of our timeline, rather than depending on wheel input.
  // Recheck after prepending messages in case the viewport is still near it.
  useEffect(() => {
    const element = ref.current
    const sentinel = olderRef.current
    if (!fullHistory || !element || !sentinel || webview.loadingOlder || !webview.snapshot?.hasMore || webview.error) return
    const observer = new IntersectionObserver(([entry]) => {
      const first = messages[0]?.ts
      if (entry?.isIntersecting && first && automaticBefore.current !== first) {
        automaticBefore.current = first
        showEarlier()
      }
    }, { root: element, rootMargin: '200px 0px 0px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [fullHistory, messages[0]?.ts, webview.loadingOlder, webview.snapshot?.hasMore, webview.error])

  const scrollToLatest = () => {
    if (fullHistory) webview.scroll('latest')
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }

  const sameGroup = (previous: Message | undefined, message: Message) =>
    Boolean(previous && messageDay(previous.ts) === messageDay(message.ts) &&
      isSameAuthorGroup(previous, message, fullHistory ? Infinity : undefined))

  return (
    <div className="timeline">
      <div ref={revealRef} className="timestamp-scroll">
        <div className="timestamp-track">
          <div
            ref={ref}
            className="message-list"
            onWheel={(event) => {
              if (fullHistory && event.deltaY < 0 && event.currentTarget.scrollTop < 200) showEarlier()
            }}
            onScroll={(event) => {
              const element = event.currentTarget
              if (!element.clientHeight) return
              const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
              position.current.atBottom = bottom
              rememberPosition(element)
              setAtBottom(bottom)
              if (fullHistory && element.scrollTop < 200) showEarlier()
            }}
          >
            <div className="message-track">
              {fullHistory && <div ref={olderRef} aria-hidden="true" />}
              {fullHistory && (
                <div className="history-status" role="status">
                  {webview.error ? <><span className="scan-error">{webview.error}</span><button className="link-button" onClick={() => void window.slackDesktop.refreshConversation(channel)}>Retry sync</button></> : !webview.snapshot ? 'Loading cached conversation…' : (
                    <span>{webview.loadingOlder ? 'Loading earlier messages…' : !webview.snapshot.hasMore ? 'Beginning of conversation' : webview.snapshot.syncing ? 'Syncing earlier messages…' : ''}</span>
                  )}
                </div>
              )}
              {messages.map((message, index) => {
                const previous = messages[index - 1]
                return (
                  <Fragment key={message.ts}>
                    {(!previous || messageDay(previous.ts) !== messageDay(message.ts)) && (
                      <div className="date-divider">{messageDay(message.ts)}</div>
                    )}
                    <MessageView
                      webview={fullHistory}
                      channel={item.conversation.id}
                      message={message}
                      continued={sameGroup(previous, message)}
                      continues={Boolean(messages[index + 1] && sameGroup(message, messages[index + 1]!))}
                    />
                  </Fragment>
                )
              })}
            </div>
          </div>
        </div>
      </div>
      {fullHistory && !atBottom && (
        <button className="jump-to-latest button" onClick={scrollToLatest} aria-label="Scroll to latest messages" title="Scroll to latest messages">
          <ArrowUpIcon />
        </button>
      )}
    </div>
  )
}
