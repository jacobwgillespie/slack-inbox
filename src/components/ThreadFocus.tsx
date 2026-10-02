import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { localApi } from '../api'
import { conversationLabel, isSameAuthorGroup } from '../format'
import { useFormatContext } from '../hooks'
import type { LaterItem, ThreadPayload } from '../slack/types'
import { inboxStore, useStore } from '../store'
import { readCachedConversation } from '../useCachedConversation'
import { Composer } from './Composer'
import { CloseIcon } from './Icons'
import { MessageView } from './Message'

export function ThreadFocus({ item, threadTs, onClose }: { item: LaterItem; threadTs: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const jumped = useRef(false)
  const [payload, setPayload] = useState<ThreadPayload>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const context = useFormatContext()
  const session = useStore((state) => state.session)

  useEffect(() => {
    const element = dialog.current!
    inboxStore.getState().clearThreadTarget()
    element.showModal()
    return () => { element.close(); inboxStore.getState().clearThreadTarget() }
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
  }, [item.conversation.id, threadTs, attempt])

  useLayoutEffect(() => {
    if (!payload || jumped.current) return
    const target = list.current?.querySelector<HTMLElement>(`[data-message-ts="${CSS.escape(item.ts)}"]`)
    if (!target || !list.current) return
    target.classList.add('saved-message')
    list.current.scrollTop = target.offsetTop - list.current.offsetTop - list.current.clientHeight / 2 + target.offsetHeight / 2
    jumped.current = true
  }, [payload, item.ts])

  const messages = payload ? [...(payload.root ? [payload.root] : []), ...payload.messages] : []
  const threadItem = payload?.root ? { ...item, thread: { ts: threadTs, root: payload.root }, messages: payload.messages } : undefined
  return <dialog ref={dialog} className="thread-focus" aria-label="Thread"
    onCancel={(event) => { event.preventDefault(); onClose() }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={(event) => event.stopPropagation()}>
    <header className="thread-focus-header">
      <div><h2>Thread</h2><span className="muted">{conversationLabel(item.conversation, context.users, session)}</span></div>
      <button className="icon-button" onClick={onClose} aria-label="Close thread" title="Close (Esc)"><CloseIcon /></button>
    </header>
    <div ref={list} className="message-list thread-focus-messages">
      {!payload && <p className="muted" role="status">{error || 'Loading thread…'}</p>}
      {error && <button className="link-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
      <div className="message-track">{messages.map((message, index) => <MessageView key={message.ts}
        channel={item.conversation.id} message={message} focusedThread
        continued={index > 1 && isSameAuthorGroup(messages[index - 1], message)}
        continues={Boolean(index > 0 && messages[index + 1] && isSameAuthorGroup(message, messages[index + 1]!))} />)}</div>
    </div>
    {threadItem && <Composer item={threadItem} />}
  </dialog>
}
