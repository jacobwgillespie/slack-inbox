import { useLayoutEffect, useRef } from 'react'
import { authorAvatar, authorName, formatMessageTime, renderEmoji, renderMrkdwn, isSameAuthorGroup } from '../format'
import { useFormatContext } from '../hooks'
import { inboxStore, threadKey, useStore } from '../store'
import type { WebviewMessage } from '../slack/webview'
import { WebviewImage } from './WebviewImage'
import type { Classification, Message } from '../slack/types'
import { Avatar } from './Avatar'
import { FileAttachment, isImageFile } from './FileAttachment'
import { ReplyIcon, ThreadIcon } from './Icons'

export function MessageView({ channel, message, continued, continues = false, webview = false }: {
  channel: string
  message: WebviewMessage
  webview?: boolean
  continued: boolean
  continues?: boolean
}) {
  const context = useFormatContext()
  const session = useStore((state) => state.session)
  const compact = useStore((state) => state.directMessages[channel]?.conversation.kind === 'dm')
  const group = useStore((state) => state.directMessages[channel]?.conversation.kind === 'group' || Boolean(state.channels[channel]))
  const thread = useStore((state) => state.threads[threadKey(channel, message.ts)])
  const { toggleThread, replyInThread } = inboxStore.getState()
  const ref = useRef<HTMLElement>(null)

  const name = authorName(message, context.users)
  const own = Boolean(session && message.user === session.userId)
  const webviewImages = message.images ?? []
  const images = webview && webviewImages.length ? [] : message.files?.filter(isImageFile) ?? []
  const files = message.files?.filter((file) => !isImageFile(file) && !message.attachments?.some((attachment) => attachment.title === file.name || attachment.title_link === file.permalink)) ?? []
  const hasBubble = Boolean(message.text.trim() || message.attachments?.length || files.length || message.classification || message.reply_count || thread)
  useLayoutEffect(() => {
    const article = ref.current
    const row = article?.parentElement
    const bubble = article?.querySelector<HTMLElement>('.message-bubble')
    if (!article || !row || !bubble || !(images.length || webviewImages.length)) return
    const alignControls = () => {
      const bounds = bubble.getBoundingClientRect()
      const center = bounds.top - row.getBoundingClientRect().top + bounds.height / 2
      row.style.setProperty('--message-control-y', `${center}px`)
    }
    alignControls()
    const observer = new ResizeObserver(alignControls)
    observer.observe(bubble)
    observer.observe(article)
    return () => {
      observer.disconnect()
      row.style.removeProperty('--message-control-y')
    }
  }, [hasBubble, images.length, webviewImages.length])

  const showName = !compact && !continued && !(group && own)
  const className = ['message', continued && 'continued', continues && 'continues', own && 'message-own'].filter(Boolean).join(' ')

  const actions = (
        <div className="message-actions" role="toolbar" aria-label={`Actions for ${name}'s message`}>
          <button
            className="icon-button"
            aria-label="Reply in thread"
            title="Reply in thread (T)"
            onClick={(event) => {
              event.stopPropagation()
              replyInThread(message.ts)
            }}
          >
            <ReplyIcon />
          </button>
        </div>
  )

  return (
    <div data-message-ts={message.ts} className={`message-row${continued ? ' continued' : ''}${own ? ' message-row-own' : ''}${group ? ' message-row-group' : ''}`}>
      {group && !own && !continues && (
        <div className="group-message-avatar">
          <Avatar url={authorAvatar(message, context.users)} name={name} size="small" />
        </div>
      )}
      <article ref={ref} className={className} aria-label={`${name}, ${formatMessageTime(message.ts)}`}>
        {showName && (group || !hasBubble) && <div className="message-author group-message-author">{name}</div>}
        {hasBubble && <div className="message-body message-bubble">
          {showName && !group && (
            <header className="message-header">
              <span className="message-author">{name}</span>
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
          {files.length ? (
            <div className="files">
              {files.map((file) => (
                <FileAttachment key={file.id} file={file} />
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
          </div>
          {thread === 'loading' && <p className="muted thread-status">Loading replies…</p>}
          {Array.isArray(thread) && (
            <div className="thread">
              {thread.map((reply, index) => (
                <ThreadReply
                  key={reply.ts}
                  message={reply}
                  compact={compact || (group && reply.user === session?.userId)}
                  continued={isSameAuthorGroup(thread[index - 1], reply)}
                />
              ))}
            </div>
          )}
          {actions}
        </div>}
        {webview && message.images?.length ? <div className="message-images">{message.images.map((image) => <WebviewImage key={image.src} image={image} />)}</div> : null}
        {images.length > 0 && (
          <div className="message-images">
            {images.map((file) => <FileAttachment key={file.id} file={file} />)}
          </div>
        )}
        {message.reactions?.length ? (
          <div className="reactions">
            {message.reactions.map((reaction) => (
              <span key={reaction.name} className="reaction">
                {renderEmoji(reaction.name.split('::')[0] ?? reaction.name, context)} {reaction.count}
              </span>
            ))}
          </div>
        ) : null}
        {!hasBubble && actions}
      </article>
      <time className="message-timestamp">{formatMessageTime(message.ts)}</time>
    </div>
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

function ThreadReply({ message, continued, compact }: { message: Message; continued: boolean; compact: boolean }) {
  const context = useFormatContext()
  const name = authorName(message, context.users)

  return (
    <div className={`thread-reply${continued ? ' continued' : ''}`}>
      <div className="message-gutter">
        {!continued && <Avatar url={authorAvatar(message, context.users)} name={name} size="small" />}
      </div>
      <div className="message-body">
        {!compact && !continued && (
          <header className="message-header">
            <span className="message-author">{name}</span>
            <time className="message-time">{formatMessageTime(message.ts)}</time>
          </header>
        )}
        <div className="mrkdwn">{renderMrkdwn(message.text, context)}</div>
        {message.files?.length ? (
          <div className="files">
            {message.files.map((file) => <FileAttachment key={file.id} file={file} />)}
          </div>
        ) : null}
      </div>
    </div>
  )
}
