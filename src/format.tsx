import { get as getEmoji } from 'node-emoji'
import { Fragment, type ReactNode } from 'react'
import type { Conversation, Message, Session, User } from './slack/types'

export interface FormatContext {
  users: Record<string, User>
  emoji: Record<string, string>
}

const INLINE_PATTERN =
  /<([^<>\s][^<>]*)>|`([^`\n]+)`|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])|(?<![\w~])~(?!\s)([^~\n]+?)(?<!\s)~(?![\w~])|:([a-z0-9_+'-]+)(?:::skin-tone-\d)?:/gi

const SAFE_LINK = /^(https?:|mailto:)/i

export function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

type Emoji = { kind: 'unicode'; value: string } | { kind: 'image'; url: string }

function resolveEmoji(name: string, context: FormatContext, depth = 0): Emoji | undefined {
  const custom = context.emoji[name]
  if (custom?.startsWith('alias:') && depth < 3) return resolveEmoji(custom.slice(6), context, depth + 1)
  if (custom) return { kind: 'image', url: custom }
  const unicode = getEmoji(name)
  return unicode ? { kind: 'unicode', value: unicode } : undefined
}

function angleLabel(body: string, context: FormatContext): { text: string; href?: string; mention?: boolean } {
  const [target = '', label] = body.split('|')
  if (target.startsWith('@')) {
    const user = context.users[target.slice(1)]
    return { text: `@${user?.displayName ?? label ?? target.slice(1)}`, mention: true }
  }
  if (target.startsWith('#')) return { text: `#${label ?? target.slice(1)}`, mention: true }
  if (target.startsWith('!subteam')) return { text: label ?? '@group', mention: true }
  if (target.startsWith('!date')) return { text: label ?? '' }
  if (target.startsWith('!')) return { text: `@${target.slice(1)}`, mention: true }
  return { text: decodeEntities(label ?? target), href: SAFE_LINK.test(target) ? decodeEntities(target) : undefined }
}

export function plainText(text: string, context: FormatContext): string {
  return decodeEntities(
    text
      .replace(/<([^<>]+)>/g, (_, body: string) => angleLabel(body, context).text)
      .replace(/:([a-z0-9_+'-]+)(?:::skin-tone-\d)?:/gi, (match, name: string) => {
        const emoji = resolveEmoji(name, context)
        return emoji?.kind === 'unicode' ? emoji.value : match
      })
      .replace(/```/g, ' ')
      .replace(/(?<=^|\s)[*_~`]+|[*_~`]+(?=\s|$|[.,!?:;])/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function renderInline(text: string, context: FormatContext): ReactNode[] {
  const nodes: ReactNode[] = []
  let index = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const [whole, angle, code, bold, italic, strike, emojiName] = match
    const start = match.index
    if (start > index) nodes.push(decodeEntities(text.slice(index, start)))
    index = start + whole.length
    const key = start

    if (angle !== undefined) {
      const { text: label, href, mention } = angleLabel(angle, context)
      if (href) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>,
        )
      } else {
        nodes.push(
          <span key={key} className={mention ? 'mention' : undefined}>
            {label}
          </span>,
        )
      }
    } else if (code !== undefined) {
      nodes.push(<code key={key}>{decodeEntities(code)}</code>)
    } else if (bold !== undefined) {
      nodes.push(<strong key={key}>{renderInline(bold, context)}</strong>)
    } else if (italic !== undefined) {
      nodes.push(<em key={key}>{renderInline(italic, context)}</em>)
    } else if (strike !== undefined) {
      nodes.push(<s key={key}>{renderInline(strike, context)}</s>)
    } else if (emojiName !== undefined) {
      const emoji = resolveEmoji(emojiName, context)
      if (!emoji) nodes.push(whole)
      else if (emoji.kind === 'unicode') nodes.push(emoji.value)
      else nodes.push(<img key={key} className="emoji" src={emoji.url} alt={whole} title={whole} />)
    }
  }
  if (index < text.length) nodes.push(decodeEntities(text.slice(index)))
  return nodes
}

function renderLines(text: string, context: FormatContext): ReactNode[] {
  const nodes: ReactNode[] = []
  const lines = text.split('\n')
  let quote: string[] = []

  const flushQuote = () => {
    if (!quote.length) return
    nodes.push(<blockquote key={`quote-${nodes.length}`}>{renderLines(quote.join('\n'), context)}</blockquote>)
    quote = []
  }

  lines.forEach((line, lineIndex) => {
    const quoted = line.match(/^&gt;\s?(.*)$/)
    if (quoted) {
      quote.push(quoted[1] ?? '')
      return
    }
    flushQuote()
    nodes.push(<Fragment key={`line-${lineIndex}`}>{renderInline(line, context)}</Fragment>)
    if (lineIndex < lines.length - 1) nodes.push('\n')
  })
  flushQuote()
  return nodes
}

export function renderMrkdwn(text: string, context: FormatContext): ReactNode[] {
  return text.split('```').map((part, index) =>
    index % 2 === 1 ? (
      <pre key={index}>{decodeEntities(part.replace(/^\n/, ''))}</pre>
    ) : (
      <Fragment key={index}>{renderLines(part, context)}</Fragment>
    ),
  )
}

export function renderEmoji(name: string, context: FormatContext): ReactNode {
  const emoji = resolveEmoji(name, context)
  if (!emoji) return `:${name}:`
  if (emoji.kind === 'unicode') return emoji.value
  return <img className="emoji" src={emoji.url} alt={`:${name}:`} />
}

export function conversationLabel(conversation: Conversation, users: Record<string, User>, session?: Session): string {
  switch (conversation.kind) {
    case 'dm':
      return users[conversation.userId ?? '']?.displayName ?? conversation.name
    case 'group':
      return conversation.name
        .split(', ')
        .filter((handle) => handle !== session?.handle)
        .join(', ')
    default:
      return `#${conversation.name}`
  }
}

export function authorName(message: Message, users: Record<string, User>): string {
  return users[message.user ?? '']?.displayName ?? message.bot_profile?.name ?? message.username ?? 'Unknown'
}

export function authorAvatar(message: Message, users: Record<string, User>): string | undefined {
  return users[message.user ?? '']?.avatar ?? message.bot_profile?.icons?.image_48
}

export function messageSummary(message: Message, context: FormatContext): string {
  const text = plainText(message.text, context)
  if (text) return text
  const attachment = message.attachments?.[0]
  if (attachment) return plainText(attachment.fallback ?? attachment.title ?? attachment.text ?? '', context)
  const file = message.files?.[0]
  if (file) return `Shared ${file.title ?? file.name ?? 'a file'}`
  return ''
}

function tsDate(ts: string): Date {
  return new Date(Number(ts.split('.')[0]) * 1000)
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

export function formatListTime(ts: string): string {
  const date = tsDate(ts)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return timeFormat.format(date)
  if (now.getTime() - date.getTime() < 6 * 24 * 60 * 60 * 1000) return weekdayFormat.format(date)
  return dateFormat.format(date)
}

export function formatMessageTime(ts: string): string {
  const date = tsDate(ts)
  if (date.toDateString() === new Date().toDateString()) return timeFormat.format(date)
  return `${dateFormat.format(date)}, ${timeFormat.format(date)}`
}

export function isSameAuthorGroup(previous: Message | undefined, message: Message, maxGapMs = 5 * 60 * 1000): boolean {
  if (!previous) return false
  const sameAuthor = previous.user === message.user && previous.username === message.username
  return sameAuthor && tsDate(message.ts).getTime() - tsDate(previous.ts).getTime() < maxGapMs
}

export function permalink(session: Session, channel: string, ts?: string): string {
  const base = `${session.url.replace(/\/$/, '')}/archives/${channel}`
  return ts ? `${base}/p${ts.replace('.', '')}` : base
}
