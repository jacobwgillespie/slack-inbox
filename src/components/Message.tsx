import { useRuntime, useConversation, useSavedMessage } from '../data'
import { commands } from '../commands'
import { useLayoutEffect, useRef, useState } from 'react'
import { authorAvatar, authorName, formatMessageTime, renderMrkdwn } from '../format'
import { useFormatContext } from '../hooks'
import type { WebviewMessage } from '../slack/webview'
import { WebviewImage } from './WebviewImage'
import { MessageImage } from './MessageImage'
import { openImageLightbox } from './ImageLightbox'
import type { Classification, Message, Reaction } from '../slack/types'
import { Avatar } from './Avatar'
import { FileAttachment, isImageFile } from './FileAttachment'
import { BookmarkIcon, ReplyIcon, ThreadIcon } from './Icons'
import { ReactionPicker } from './ReactionPicker'
import { ReactionList } from './ReactionList'
import { readCachedConversation } from '../useCachedConversation'
import { messageCollection } from '../collections'

async function refreshReactions(channel: string, ts: string, reactions: Reaction[]) {
  const id = `${channel}:${ts}`
  if (messageCollection.has(id)) messageCollection.update(id, (message) => { message.reactions = reactions })
  await readCachedConversation(channel)
}


export function MessageView({ channel, message, continued, continues = false, webview = false, focusedThread = false }: {
  channel: string
  message: WebviewMessage
  focusedThread?: boolean
  webview?: boolean
  continued: boolean
  continues?: boolean
}) {
  const context = useFormatContext(message.emoji)
  const session = useRuntime().session
  const conversation = useConversation(channel)
  const compact = conversation?.conversation.kind === 'dm'
  const group = Boolean(conversation && !compact)
  const { toggleThread, replyInThread } = commands
  const ref = useRef<HTMLElement>(null)

  const name = authorName(message, context.users)
  const own = Boolean(session && message.user === session.userId)
  const blockImages = message.blocks?.filter((block) => block.type === 'image' && block.image_url) ?? []
  const webviewImages = message.images?.filter((image) => !blockImages.some((block) => block.image_url === image.src)) ?? []
  const images = webview && webviewImages.length ? [] : message.files?.filter(isImageFile) ?? []
  const files = message.files?.filter((file) => !isImageFile(file) && !message.attachments?.some((attachment) => attachment.title === file.name || attachment.title_link === file.permalink)) ?? []
  const hasBubble = Boolean(message.text.trim() || message.attachments?.length || files.length || message.classification || message.reply_count)
  useLayoutEffect(() => {
    const article = ref.current
    const row = article?.parentElement
    const bubble = article?.querySelector<HTMLElement>(':scope > .message-bubble')
    if (!article || !row || !bubble) return
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
          <SaveLaterButton channel={channel} message={message} />
          <ReactionPicker channel={channel} ts={message.ts} onReact={(reactions) => refreshReactions(channel, message.ts, reactions)} />
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
                  <div className="attachment-title mrkdwn">{renderMrkdwn(attachment.title, context)}</div>
                ))}
              {attachment.text && <div className="mrkdwn">{renderMrkdwn(attachment.text, context)}</div>}
              {!attachment.title && !attachment.text && !attachment.image_url && attachment.fallback && (
                <div className="mrkdwn">{renderMrkdwn(attachment.fallback, context)}</div>
              )}
              {attachment.image_url && !(webview && webviewImages.length) && <MessageImage className="attachment-image" src={attachment.image_url} alt={attachment.fallback || 'Image attachment'} loading="lazy" />}
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
            {!focusedThread && message.reply_count ? (
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
          {actions}
        </div>}
        {blockImages.length > 0 && <div className="message-images">{blockImages.map((image, index) => (
          <button key={`${image.image_url}:${index}`} className="file-image" aria-label={`Open image: ${image.alt_text || 'Image attachment'}`}
            onClick={(event) => { event.stopPropagation(); openImageLightbox(image.image_url!, image.alt_text || '') }}>
            <MessageImage className="attachment-image" src={image.image_url} alt={image.alt_text || 'Image attachment'} loading="lazy" />
          </button>
        ))}</div>}
        {webview && webviewImages.length ? <div className="message-images">{webviewImages.map((image) => <WebviewImage key={image.src} image={image} />)}</div> : null}
        {images.length > 0 && (
          <div className="message-images">
            {images.map((file) => <FileAttachment key={file.id} file={file} />)}
          </div>
        )}
        <ReactionList channel={channel} message={message} onChange={(reactions) => refreshReactions(channel, message.ts, reactions)} />
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

function SaveLaterButton({ channel, message, className = '' }: { channel: string; message: Message; className?: string }) {
  const saved = useSavedMessage(channel, message.ts)
  const [saving, setSaving] = useState(false)
  const label = saved ? 'Remove message from Later' : 'Save message for later'
  return (
    <button
      className={`icon-button save-later-button${saved ? ' is-saved' : ''} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={saved}
      disabled={saving}
      onClick={(event) => {
        event.stopPropagation()
        setSaving(true)
        void commands.toggleMessageSaved(channel, message).finally(() => setSaving(false))
      }}
    ><BookmarkIcon /></button>
  )
}
