import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { localApi } from '../api'
import { isSameAuthorGroup } from '../format'
import type { LaterItem, ThreadPayload } from '../slack/types'
import { inboxStore, useStore } from '../store'
import { readCachedConversation } from '../useCachedConversation'
import { Composer } from './Composer'
import { MessageView } from './Message'

export function ThreadFocus({ item, threadTs, onClose }: { item: LaterItem; threadTs: string; onClose: () => void }) {
  const section = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [payload, setPayload] = useState<ThreadPayload>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const lastSync = useStore((state) => state.sync?.lastCompletedAt)

  useEffect(() => {
    inboxStore.getState().clearThreadTarget()
    section.current?.focus()
    return () => inboxStore.getState().clearThreadTarget()
  }, [])

  useEffect(() => {
    let disposed = false
    setError(undefined)
    void localApi.threadReplies(item.conversation.id, threadTs).then((result) => {
      if (disposed) return
      inboxStore.setState((state) => ({ users: { ...state.users, ...result.users } }))
      setPayload(result)
      void readCachedConversation(item.conversation.id).catch(console.error)
    }).catch((error) => { if (!disposed) setError(error instanceof Error ? error.message : 'Could not load thread') })
    return () => { disposed = true }
  }, [item.conversation.id, threadTs, attempt, lastSync])

  useLayoutEffect(() => {
    if (!payload) return
    const target = list.current?.querySelector<HTMLElement>(`[data-message-ts="${CSS.escape(item.ts)}"]`)
    if (!target || !list.current) return
    target.classList.add('saved-message')
  }, [payload, item.ts])

  const messages = payload ? [...(payload.root ? [payload.root] : []), ...payload.messages] : []
  const threadItem = payload?.root ? { ...item, thread: { ts: threadTs, root: payload.root }, messages: payload.messages } : undefined
  return <section ref={section} className="thread-focus" aria-label="Thread" tabIndex={-1}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && !event.defaultPrevented) onClose() }}>
    <div ref={list} className="message-list thread-focus-messages">
      {!payload && <p className="muted" role="status">{error || 'Loading thread…'}</p>}
      {error && <button className="link-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
      <div className="message-track">{messages.map((message, index) => <MessageView key={message.ts}
        channel={item.conversation.id} message={message} focusedThread
        continued={index > 1 && isSameAuthorGroup(messages[index - 1], message)}
        continues={Boolean(index > 0 && messages[index + 1] && isSameAuthorGroup(message, messages[index + 1]!))} />)}</div>
    </div>
    {threadItem && <Composer item={threadItem} />}
  </section>
}
