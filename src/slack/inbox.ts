import { call, paginate } from './api'
import type { Conversation, ConversationKind, Message, Session, User } from './types'

const IGNORED_SUBTYPES = new Set(['channel_join', 'channel_leave', 'group_join', 'group_leave'])
const KIND_PRIORITY: Record<ConversationKind, number> = { dm: 0, group: 1, private: 2, channel: 3 }
const HISTORY_LIMIT = 100

interface RawConversation {
  id: string
  name?: string
  user?: string
  is_im?: boolean
  is_mpim?: boolean
  is_private?: boolean
  is_user_deleted?: boolean
  last_read?: string
}

interface RawUser {
  id: string
  name: string
  deleted?: boolean
  profile?: { display_name?: string; real_name?: string; image_48?: string }
}

interface RawCount {
  id: string
  last_read?: string
  latest?: string
  has_unreads?: boolean
}

interface UnreadHint {
  lastRead: string
  hasUnreads: boolean
}

export interface ScanHandlers {
  onStart: (total: number) => void
  onResult: (conversation: Conversation, lastRead: string, messages: Message[]) => void
  onProgress: () => void
}

export function precedingTs(ts: string): string {
  const [seconds = '0', micros = '0'] = ts.split('.')
  const previous = Number(micros) - 1
  if (previous >= 0) return `${seconds}.${String(previous).padStart(6, '0')}`
  return `${Number(seconds) - 1}.999999`
}

export function compareTs(a: string, b: string): number {
  const [aSeconds = '0', aMicros = '0'] = a.split('.')
  const [bSeconds = '0', bMicros = '0'] = b.split('.')
  return Number(aSeconds) - Number(bSeconds) || Number(aMicros.padEnd(6, '0')) - Number(bMicros.padEnd(6, '0'))
}

export function maxTs(...values: (string | undefined)[]): string {
  return values.reduce<string>((max, value) => (value && compareTs(value, max) > 0 ? value : max), '0')
}

function toConversation(raw: RawConversation): Conversation {
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

export async function fetchSession(): Promise<Session> {
  const result = await call<{ user_id: string; user: string; team_id: string; url: string }>('auth.test')
  return { userId: result.user_id, handle: result.user, teamId: result.team_id, url: result.url }
}

export async function fetchUsers(): Promise<Record<string, User>> {
  const members = await paginate<RawUser>('users.list', 'members', { limit: 1000 })
  return Object.fromEntries(members.map((member) => [member.id, toUser(member)]))
}

export async function fetchUser(id: string): Promise<User> {
  const result = await call<{ user: RawUser }>('users.info', { user: id })
  return toUser(result.user)
}

export async function fetchCustomEmoji(): Promise<Record<string, string>> {
  const result = await call<{ emoji: Record<string, string> }>('emoji.list')
  return result.emoji
}

async function fetchUnreadHints(): Promise<Map<string, UnreadHint> | undefined> {
  try {
    const result = await call<{ channels?: RawCount[]; mpims?: RawCount[]; ims?: RawCount[] }>('client.counts')
    const counts = [...(result.channels ?? []), ...(result.mpims ?? []), ...(result.ims ?? [])]
    return new Map(
      counts.map((count) => [
        count.id,
        {
          lastRead: count.last_read ?? '0',
          hasUnreads: Boolean(count.has_unreads) || compareTs(count.latest ?? '0', count.last_read ?? '0') > 0,
        },
      ]),
    )
  } catch {
    return undefined
  }
}

async function fetchLastRead(channel: string): Promise<string> {
  const result = await call<{ channel: RawConversation }>('conversations.info', { channel })
  return result.channel.last_read ?? '0'
}

async function fetchUnreadMessages(channel: string, lastRead: string, selfId: string): Promise<Message[]> {
  const result = await call<{ messages: Message[] }>('conversations.history', {
    channel,
    oldest: lastRead,
    limit: HISTORY_LIMIT,
  })
  return result.messages
    .filter((message) => compareTs(message.ts, lastRead) > 0)
    .filter((message) => message.user !== selfId && !IGNORED_SUBTYPES.has(message.subtype ?? ''))
    .reverse()
}

export async function fetchThreadReplies(channel: string, ts: string): Promise<Message[]> {
  const messages = await paginate<Message>('conversations.replies', 'messages', { channel, ts, limit: 200 })
  return messages.filter((message) => message.ts !== ts)
}

export async function markRead(channel: string, ts: string): Promise<void> {
  await call('conversations.mark', { channel, ts })
}

export async function postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
  await call('chat.postMessage', { channel, text, thread_ts: threadTs })
}

export async function scanInbox(selfId: string, handlers: ScanHandlers): Promise<void> {
  const [rawConversations, hints] = await Promise.all([
    paginate<RawConversation>('users.conversations', 'channels', {
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: true,
      limit: 200,
    }),
    fetchUnreadHints(),
  ])

  const conversations = rawConversations
    .filter((raw) => !raw.is_user_deleted)
    .map((raw) => ({ raw, conversation: toConversation(raw) }))
    .sort((a, b) => KIND_PRIORITY[a.conversation.kind] - KIND_PRIORITY[b.conversation.kind])

  const candidates = hints ? conversations.filter(({ raw }) => hints.get(raw.id)?.hasUnreads) : conversations
  if (hints) {
    for (const { raw, conversation } of conversations) {
      if (!hints.get(raw.id)?.hasUnreads) handlers.onResult(conversation, hints.get(raw.id)?.lastRead ?? '0', [])
    }
  }

  handlers.onStart(candidates.length)
  await Promise.all(
    candidates.map(async ({ raw, conversation }) => {
      try {
        const lastRead = hints?.get(raw.id)?.lastRead ?? (await fetchLastRead(raw.id))
        const messages = await fetchUnreadMessages(raw.id, lastRead, selfId)
        handlers.onResult(conversation, lastRead, messages)
      } catch (error) {
        console.warn(`Could not load ${conversation.name}`, error)
      } finally {
        handlers.onProgress()
      }
    }),
  )
}
