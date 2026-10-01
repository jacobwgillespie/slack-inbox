import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { authorName, conversationLabel } from '../format'
import { useFormatContext } from '../hooks'
import { inboxStore, findMessage, threadTargetFor, useStore } from '../store'
import type { InboxItem } from '../slack/types'
import { ArrowUpIcon } from './Icons'

export function Composer({ item }: { item: InboxItem }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const context = useFormatContext()
  const session = useStore((state) => state.session)
  const threadTarget = useStore((state) => state.threadTarget)
  const focusRequest = useStore((state) => state.composerFocusRequest)
  const focusChannel = useStore((state) => state.composerFocusChannel)
  const { send, clearThreadTarget } = inboxStore.getState()
  const handledFocusRequest = useRef(focusRequest)

  useEffect(() => {
    if (focusRequest !== handledFocusRequest.current && focusChannel === item.conversation.id) ref.current?.focus()
    handledFocusRequest.current = focusRequest
  }, [focusRequest, focusChannel, item.conversation.id])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`
  }, [text])

  const replyThread = threadTargetFor(item, threadTarget)
  const threadParent = replyThread ? findMessage(item, replyThread) : undefined
  const label = conversationLabel(item.conversation, context.users, session)
  const placeholder = replyThread ? 'Reply in thread' : `Message ${label}`

  const submit = async () => {
    if (sending || !text.trim()) return
    setSending(true)
    const sent = await send(text)
    setSending(false)
    if (sent) {
      setText('')
      ref.current?.blur()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      clearThreadTarget()
      ref.current?.blur()
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {replyThread && (
        <div className="composer-context">
          Replying in thread{threadParent ? ` to ${authorName(threadParent, context.users)}` : ''}
          {threadTarget && !item.thread && (
            <button type="button" className="link-button" onClick={clearThreadTarget}>
              Cancel
            </button>
          )}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
        />
        <button
          className="send-button"
          type="submit"
          disabled={sending || !text.trim()}
          aria-label={sending ? 'Sending' : 'Send message'}
          title="Send message (Enter)"
        >
          <ArrowUpIcon />
        </button>
      </div>
    </form>
  )
}
