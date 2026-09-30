import { compareTs } from '../src/slack/timestamps.ts'
import type { Conversation, Message, User } from '../src/slack/types.ts'

export interface RawConversation {
  id: string
  name?: string
  user?: string
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  is_user_deleted?: boolean
  last_read?: string
}

export interface RawUser {
  id: string
  name: string
  profile?: { display_name?: string; real_name?: string; image_48?: string }
}

export interface RawCount {
  id: string
  last_read?: string
  latest?: string
  has_unreads?: boolean
}

export function toConversation(raw: RawConversation): Conversation {
  if (raw.is_im) return { id: raw.id, name: raw.user ?? raw.id, kind: 'dm', userId: raw.user }
  if (raw.is_mpim) {
    const handles = (raw.name ?? '').replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--')
    return { id: raw.id, name: handles.join(', '), kind: 'group' }
  }
  return { id: raw.id, name: raw.name ?? raw.id, kind: raw.is_private ? 'private' : 'channel' }
}

export function toUser(raw: RawUser): User {
  const profile = raw.profile ?? {}
  return {
    id: raw.id,
    handle: raw.name,
    displayName: profile.display_name || profile.real_name || raw.name,
    avatar: profile.image_48,
  }
}

export function toMessage(raw: Message): Message {
  return {
    ts: raw.ts,
    text: raw.text ?? '',
    user: raw.user,
    username: raw.username,
    subtype: raw.subtype,
    thread_ts: raw.thread_ts,
    reply_count: raw.reply_count,
    files: raw.files?.map(({ id, name, title, permalink }) => ({ id, name, title, permalink })),
    attachments: raw.attachments?.map(({ fallback, pretext, title, title_link, text }) => ({
      fallback,
      pretext,
      title,
      title_link,
      text,
    })),
    reactions: raw.reactions?.map(({ name, count }) => ({ name, count })),
    bot_profile: raw.bot_profile && { name: raw.bot_profile.name, icons: { image_48: raw.bot_profile.icons?.image_48 } },
  }
}

export function hasUnreads(count: RawCount): boolean {
  return Boolean(count.has_unreads) || compareTs(count.latest ?? '0', count.last_read ?? '0') > 0
}
