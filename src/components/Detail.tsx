import { useEffect, useRef } from 'react'
import {
  authorAvatar,
  authorName,
  conversationLabel,
  formatMessageTime,
  isSameAuthorGroup,
  permalink,
  renderEmoji,
  renderMrkdwn,
} from '../format'
import { useCurrentItem, useFormatContext } from '../hooks'
import { threadKey, useStore } from '../store'
import type { Classification, InboxItem, Message } from '../slack/types'
import { Avatar } from './Avatar'
import { Composer } from './Composer'
import { CheckIcon, ClockIcon, ExternalIcon, MuteIcon, SwapIcon, ThreadIcon } from './Icons'

const KIND_LABELS = { channel: 'Channel', private: 'Private channel', dm: 'Direct message', group: 'Group message' }

function unreadSummary(item: InboxItem): string {
  const count = item.messages.length
  if (item.thread) return `${count} new ${count === 1 ? 'reply' : 'replies'}`
  return `${count} unread`
}

export function Detail() {
  const item = useCurrentItem()
  const context = useFormatContext()
  const session = useStore((state) => state.session)
  const view = useStore((state) => state.view)
  const reading = useStore((state) => state.mode === 'reading')
  const { markDone, saveForLater, toggleMute, recategorize, openInSlack } = useStore.getState()

  if (!item) {
    return (
      <section className="detail detail-empty">
        <p className="muted">Select a conversation to read it.</p>
      </section>
    )
  }

  const { id } = item

  return (
    <section className={`detail${reading ? ' reading' : ''}`} aria-label="Conversation">
      <header className="detail-header">
        <div>
          <h2>{conversationLabel(item.conversation, context.users, session)}</h2>
          <p className="muted">
            {item.thread ? 'Thread' : KIND_LABELS[item.conversation.kind]} ·{' '}
            {view === 'later' ? 'Saved for later' : unreadSummary(item)}
          </p>
        </div>
        <div className="detail-actions">
          <button className="button" onClick={() => markDone([id])} title="E">
            <CheckIcon /> {view === 'later' ? 'Complete' : 'Mark read'}
          </button>
          {view !== 'later' && (
            <>
              <button className="button" onClick={() => saveForLater([id])} title="L">
                <ClockIcon /> Later
              </button>
              {!item.thread && view !== 'muted' && (
                <button className="button" onClick={() => recategorize([id])} title="C">
                  <SwapIcon /> {view === 'important' ? 'Move to Other' : 'Move to Important'}
                </button>
              )}
              {!item.thread && (
                <button className="button" onClick={() => toggleMute([id])} title="M">
                  <MuteIcon /> {view === 'muted' ? 'Unmute' : 'Mute'}
                </button>
              )}
            </>
          )}
          <button className="button" onClick={openInSlack} title="U">
            <ExternalIcon /> Slack
          </button>
        </div>
      </header>
      <div className="message-list">
        {item.thread && (
          <>
            <MessageView channel={item.conversation.id} message={item.thread.root} continued={false} />
            <div className="thread-divider">
              {item.messages.length} new {item.messages.length === 1 ? 'reply' : 'replies'}
            </div>
          </>
        )}
        {item.messages.map((message, index) => (
          <MessageView
            key={message.ts}
            channel={item.conversation.id}
            message={message}
            continued={isSameAuthorGroup(item.messages[index - 1], message)}
          />
        ))}
      </div>
      <Composer key={id} item={item} />
    </section>
  )
}

function MessageView({ channel, message, continued }: { channel: string; message: Message; continued: boolean }) {
  const context = useFormatContext()
  const session = useStore((state) => state.session)
  const focused = useStore((state) => state.mode === 'reading' && state.focusedTs === message.ts)
  const thread = useStore((state) => state.threads[threadKey(channel, message.ts)])
  const { focusMessage, toggleThread, replyInThread } = useStore.getState()
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const name = authorName(message, context.users)
  const className = ['message', continued && 'continued', focused && 'focused'].filter(Boolean).join(' ')

  return (
    <article ref={ref} className={className} onClick={() => focusMessage(message.ts)}>
      <div className="message-gutter">
        {continued ? (
          <time className="message-gutter-time">{formatMessageTime(message.ts)}</time>
        ) : (
          <Avatar url={authorAvatar(message, context.users)} name={name} />
        )}
      </div>
      <div className="message-body">
        {!continued && (
          <header className="message-header">
            <span className="message-author">{name}</span>
            {session ? (
              <a
                className="message-time"
                href={permalink(session, channel, message.ts)}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {formatMessageTime(message.ts)}
              </a>
            ) : (
              <time className="message-time">{formatMessageTime(message.ts)}</time>
            )}
          </header>
        )}
        <div className="mrkdwn">{renderMrkdwn(message.text, context)}</div>
        {message.attachments?.map((attachment, index) => (
          <div key={index} className="attachment">
            {attachment.pretext && <div className="mrkdwn">{renderMrkdwn(attachment.pretext, context)}</div>}
            {attachment.title &&
              (attachment.title_link ? (
                <a className="attachment-title" href={attachment.title_link} target="_blank" rel="noreferrer">
                  {attachment.title}
                </a>
              ) : (
                <div className="attachment-title">{attachment.title}</div>
              ))}
            {attachment.text && <div className="mrkdwn">{renderMrkdwn(attachment.text, context)}</div>}
            {!attachment.title && !attachment.text && attachment.fallback && (
              <div className="mrkdwn">{renderMrkdwn(attachment.fallback, context)}</div>
            )}
          </div>
        ))}
        {message.files?.length ? (
          <div className="files">
            {message.files.map((file) => (
              <a key={file.id} className="file" href={file.permalink} target="_blank" rel="noreferrer">
                {file.title ?? file.name ?? 'File'}
              </a>
            ))}
          </div>
        ) : null}
        {message.reactions?.length ? (
          <div className="reactions">
            {message.reactions.map((reaction) => (
              <span key={reaction.name} className="reaction">
                {renderEmoji(reaction.name.split('::')[0] ?? reaction.name, context)} {reaction.count}
              </span>
            ))}
          </div>
        ) : null}
        <div className="message-footer">
          {message.classification && <ClassificationTag classification={message.classification} />}
          {message.reply_count ? (
            <button
              className="link-button"
              onClick={(event) => {
                event.stopPropagation()
                toggleThread(message.ts)
              }}
            >
              <ThreadIcon /> {message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
            </button>
          ) : null}
          <button
            className="link-button subtle"
            onClick={(event) => {
              event.stopPropagation()
              focusMessage(message.ts)
              replyInThread(message.ts)
            }}
          >
            Reply in thread
          </button>
        </div>
        {thread === 'loading' && <p className="muted thread-status">Loading replies…</p>}
        {Array.isArray(thread) && (
          <div className="thread">
            {thread.map((reply, index) => (
              <ThreadReply key={reply.ts} message={reply} continued={isSameAuthorGroup(thread[index - 1], reply)} />
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

function ClassificationTag({ classification }: { classification: Classification }) {
  const label = classification.label === 'important' ? 'Important' : 'Other'
  const source = classification.source === 'user' ? 'Set by you' : 'Sorted by the classifier'
  return (
    <span className={`classification classification-${classification.label}`} title={`${source}: ${classification.reason}`}>
      {label}
    </span>
  )
}

function ThreadReply({ message, continued }: { message: Message; continued: boolean }) {
  const context = useFormatContext()
  const name = authorName(message, context.users)

  return (
    <div className={`thread-reply${continued ? ' continued' : ''}`}>
      <div className="message-gutter">
        {!continued && <Avatar url={authorAvatar(message, context.users)} name={name} size="small" />}
      </div>
      <div className="message-body">
        {!continued && (
          <header className="message-header">
            <span className="message-author">{name}</span>
            <time className="message-time">{formatMessageTime(message.ts)}</time>
          </header>
        )}
        <div className="mrkdwn">{renderMrkdwn(message.text, context)}</div>
      </div>
    </div>
  )
}
