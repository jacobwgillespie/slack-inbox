import { useRuntime } from '../data'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { messageCollection, userCollection, reconcile, reconcileMessages } from '../collections'
import { LocalApiError, localApi } from '../api'
import { formatMessageDivider, hasMessageTimeGap, isSameAuthorGroup } from '../format'
import type { InboxItem, ThreadPayload } from '../slack/types'
import { useStore } from '../store'
import { readCachedConversation } from '../useCachedConversation'
import { Composer } from './Composer'
import { MessageView } from './Message'

export function ThreadFocus({ item, threadTs, savedTs, onClose }: { item: InboxItem; threadTs: string; savedTs?: string; onClose: () => void }) {
  const section = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [payload, setPayload] = useState<ThreadPayload>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const { data: cachedMessages } = useLiveQuery({ query: (q) => q.from({ message: messageCollection })
    .where(({ message }) => eq(message.channel, item.conversation.id)), queryKey: [item.conversation.id] })
  const lastSync = useRuntime().sync?.lastCompletedAt
  const replying = useStore((state) => state.threadTarget === threadTs)

  useEffect(() => {
    section.current?.focus()
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.slackDesktop.onCacheChange((channel) => {
      if (channel && channel !== item.conversation.id) return
      clearTimeout(timer)
      timer = setTimeout(() => setAttempt((value) => value + 1), 500)
    })
    return () => { unsubscribe(); clearTimeout(timer) }
  }, [item.conversation.id])

  useEffect(() => {
    let disposed = false
    setError(undefined)
    void localApi.threadReplies(item.conversation.id, threadTs).then((result) => {
      if (disposed) return
      reconcile(userCollection, Object.values(result.users), false)
      const messages = [...(result.root ? [result.root] : []), ...result.messages]
      const timestamps = new Set(messages.map((message) => message.ts))
      for (const message of messageCollection.values()) {
        if (!message.pending && message.channel === item.conversation.id && message.thread_ts === threadTs && !timestamps.has(message.ts)) messageCollection.delete(message.id)
      }
      reconcileMessages(messages.map((message) => ({ ...message, id: `${item.conversation.id}:${message.ts}`, channel: item.conversation.id })))
      setPayload(result)
      void readCachedConversation(item.conversation.id).catch(console.error)
    }).catch((error) => {
      if (disposed || error instanceof LocalApiError && error.code === 'session_not_ready') return
      setError(error instanceof Error ? error.message : 'Could not load thread')
    })
    return () => { disposed = true }
  }, [item.conversation.id, threadTs, attempt, lastSync])

  useLayoutEffect(() => {
    if (!payload || !savedTs) return
    const target = list.current?.querySelector<HTMLElement>(`[data-message-ts="${CSS.escape(savedTs)}"]`)
    if (!target || !list.current) return
    target.classList.add('saved-message')
  }, [payload, savedTs, cachedMessages])

  useLayoutEffect(() => {
    const pending = cachedMessages.findLast((message) => message.pending && message.thread_ts === threadTs)
    if (pending) list.current?.querySelector<HTMLElement>(`[data-message-ts="${CSS.escape(pending.ts)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cachedMessages, threadTs, payload])

  const messages = payload ? cachedMessages.filter((message) => message.ts === threadTs || message.thread_ts === threadTs)
    .sort((a, b) => a.ts.localeCompare(b.ts)) : []
  const threadItem = payload?.root ? { ...item, thread: { ts: threadTs, root: payload.root }, messages: payload.messages } : undefined
  return <section ref={section} className="thread-focus" aria-label="Thread" tabIndex={-1}
    onClick={(event) => {
      const target = event.target as HTMLElement
      if (target === event.currentTarget || target === list.current || target.matches('.message-track, .message-row')) onClose()
    }}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && !event.defaultPrevented) onClose() }}>
    <div ref={list} className="message-list thread-focus-messages">
      {!payload && <p className="muted" role="status">{error || 'Loading thread…'}</p>}
      {error && <button className="link-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
      <div className="message-track">{messages.map((message, index) => {
        const previous = messages[index - 1]
        const next = messages[index + 1]
        return <Fragment key={message.ts}>
          {hasMessageTimeGap(previous, message) && <div className="date-divider">{formatMessageDivider(message.ts)}</div>}
          <MessageView channel={item.conversation.id} message={message} focusedThread
            continued={index > 1 && !hasMessageTimeGap(previous, message) && isSameAuthorGroup(previous, message)}
            continues={Boolean(index > 0 && next && !hasMessageTimeGap(message, next) && isSameAuthorGroup(message, next))} />
        </Fragment>
      })}</div>
    </div>
    {threadItem && <Composer item={threadItem} autoFocus={replying} />}
  </section>
}
