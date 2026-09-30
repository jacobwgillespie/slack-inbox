import type {
  ConversationKind,
  CredentialMode,
  InboxItem,
  InboxPayload,
  Message,
  Session,
  SyncError,
  SyncStatus,
  ThreadPayload,
} from '../src/slack/types'
import type { Database, StoredConversation } from './database'
import { SlackError, type SlackClient } from './slack-client'
import {
  hasUnreads,
  toConversation,
  toMessage,
  toUser,
  type RawConversation,
  type RawCount,
  type RawUser,
} from './slack-data'

const SESSION_SYNC_INTERVAL = 30 * 1000
const USER_SYNC_INTERVAL = 60 * 1000
const DIRECTORY_MAX_AGE = 60 * 60 * 1000
const HISTORY_LIMIT = 100
const INBOX_MESSAGE_LIMIT = 100
const CHANGE_NOTIFICATION_DELAY = 250
const KIND_PRIORITY: Record<ConversationKind, number> = { dm: 0, group: 1, private: 2, channel: 3 }
const USER_MENTION = /<@([UW][A-Z0-9]+)/g

type DirectoryKey = 'conversations' | 'users' | 'emoji'

function describeError(error: unknown): SyncError {
  if (error instanceof SlackError) return { code: error.code, needed: error.needed, message: error.message }
  return { code: 'internal_error', message: error instanceof Error ? error.message : String(error) }
}

function referencedUserIds(items: InboxItem[]): string[] {
  const ids = new Set<string>()
  const addMessage = (message: Message) => {
    if (message.user) ids.add(message.user)
    for (const match of message.text.matchAll(USER_MENTION)) if (match[1]) ids.add(match[1])
  }
  for (const item of items) {
    if (item.conversation.userId) ids.add(item.conversation.userId)
    item.messages.forEach(addMessage)
  }
  return [...ids]
}

function messageUserIds(messages: Message[]): string[] {
  return referencedUserIds([{ conversation: { id: '', name: '', kind: 'channel' }, messages }])
}

export class SyncEngine {
  private version = 0
  private status: SyncStatus
  private session?: Session
  private sessionVerified = false
  private running?: Promise<void>
  private pending = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private notifyTimer?: ReturnType<typeof setTimeout>
  private readonly listeners = new Set<(version: number) => void>()
  private readonly requestedUsers = new Set<string>()

  constructor(
    private readonly database: Database,
    private readonly client: SlackClient,
    mode: CredentialMode,
  ) {
    this.status = { mode, running: false, done: 0, total: 0 }
    this.session = database.getMetadata<Session>('session')
  }

  start() {
    this.requestSync()
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.notifyTimer)
    this.listeners.clear()
    await this.running?.catch(() => undefined)
  }

  subscribe(listener: (version: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  requestSync() {
    if (this.stopped) return
    if (this.running) {
      this.pending = true
      return
    }
    clearTimeout(this.timer)
    this.running = this.runSync().finally(() => {
      this.running = undefined
      if (this.stopped) return
      if (this.pending) {
        this.pending = false
        this.requestSync()
        return
      }
      const interval = this.status.mode === 'session' ? SESSION_SYNC_INTERVAL : USER_SYNC_INTERVAL
      this.timer = setTimeout(() => this.requestSync(), interval)
    })
  }

  inbox(): InboxPayload {
    const items = this.session ? this.database.inbox(this.session.userId, INBOX_MESSAGE_LIMIT) : []
    const ids = referencedUserIds(items)
    const users = this.database.usersById(ids)
    this.requestMissingUsers(ids.filter((id) => !users[id]))
    return { version: this.version, session: this.session, sync: this.status, items, users }
  }

  emoji(): Record<string, string> {
    return this.database.emoji()
  }

  async markRead(channel: string, ts: string) {
    await this.client.call('conversations.mark', { channel, ts })
    this.database.setReadStates([[channel, ts]])
    this.changed()
  }

  async postMessage(channel: string, text: string, threadTs?: string) {
    const result = await this.client.call<{ message?: Message }>('chat.postMessage', {
      channel,
      text,
      thread_ts: threadTs,
    })
    if (result.message) this.database.upsertMessages(channel, [toMessage(result.message)])
    this.changed()
  }

  async threadReplies(channel: string, ts: string): Promise<ThreadPayload> {
    const raw = await this.client.paginate<Message>('conversations.replies', 'messages', { channel, ts, limit: 200 })
    const all = raw.map(toMessage)
    this.database.upsertMessages(channel, all)
    const messages = all.filter((message) => message.ts !== ts)
    const ids = messageUserIds(messages)
    const users = this.database.usersById(ids)
    this.requestMissingUsers(ids.filter((id) => !users[id]))
    return { messages, users }
  }

  private async runSync() {
    this.setStatus({ running: true, done: 0, total: 0, error: undefined })
    try {
      await this.ensureSession()
      await this.refreshDirectory('conversations')
      if (this.status.mode === 'session') await this.syncWithCounts()
      else await this.syncWithConversationInfo()
      await this.refreshDirectory('users')
      await this.refreshDirectory('emoji').catch(() => undefined)
      this.setStatus({ lastCompletedAt: Date.now() })
    } catch (error) {
      console.error('Slack sync failed', error)
      this.setStatus({ error: describeError(error) })
    } finally {
      this.setStatus({ running: false })
    }
  }

  private async ensureSession() {
    if (this.status.mode === 'none') throw new SlackError('auth.test', 'not_authed')
    if (this.sessionVerified) return
    const result = await this.client.call<{ user_id: string; user: string; team_id: string; url: string }>('auth.test')
    const session = { userId: result.user_id, handle: result.user, teamId: result.team_id, url: result.url }
    if (this.session && (this.session.userId !== session.userId || this.session.teamId !== session.teamId)) {
      this.database.clearWorkspace()
    }
    this.session = session
    this.sessionVerified = true
    this.database.setMetadata('session', session)
  }

  private isStale(key: DirectoryKey) {
    const syncedAt = this.database.getMetadata<number>(`${key}_synced_at`) ?? 0
    return Date.now() - syncedAt > DIRECTORY_MAX_AGE
  }

  private async refreshDirectory(key: DirectoryKey, force = false) {
    if (!force && !this.isStale(key)) return
    switch (key) {
      case 'conversations': {
        const raw = await this.client.paginate<RawConversation>('users.conversations', 'channels', {
          types: 'public_channel,private_channel,mpim,im',
          exclude_archived: true,
          limit: 200,
        })
        this.database.replaceConversations(raw.filter((entry) => !entry.is_user_deleted).map(toConversation))
        break
      }
      case 'users': {
        const members = await this.client.paginate<RawUser>('users.list', 'members', { limit: 1000 })
        this.database.replaceUsers(members.map(toUser))
        break
      }
      case 'emoji': {
        const result = await this.client.call<{ emoji: Record<string, string> }>('emoji.list')
        this.database.replaceEmoji(result.emoji)
        break
      }
    }
    this.database.setMetadata(`${key}_synced_at`, Date.now())
    this.changed()
  }

  private async syncWithCounts() {
    const result = await this.client.call<{ channels?: RawCount[]; mpims?: RawCount[]; ims?: RawCount[] }>(
      'client.counts',
    )
    const counts = [...(result.channels ?? []), ...(result.mpims ?? []), ...(result.ims ?? [])]
    let known = new Map(this.database.conversations().map((stored) => [stored.conversation.id, stored]))
    if (counts.some((count) => hasUnreads(count) && !known.has(count.id))) {
      await this.refreshDirectory('conversations', true)
      known = new Map(this.database.conversations().map((stored) => [stored.conversation.id, stored]))
    }

    const tracked = counts.filter((count) => known.has(count.id))
    this.database.setReadStates(tracked.map((count) => [count.id, count.last_read ?? '0']))
    this.changed()

    const outdated = tracked.filter(
      (count) => hasUnreads(count) && (count.latest === undefined || count.latest !== known.get(count.id)?.historyLatest),
    )
    this.setStatus({ total: outdated.length })
    await Promise.all(
      outdated.map(async (count) => {
        if (this.stopped) return
        try {
          await this.fetchUnreadWindow(count.id, count.last_read ?? '0', count.latest)
        } catch (error) {
          console.warn(`Could not sync ${known.get(count.id)?.conversation.name ?? count.id}`, error)
        } finally {
          this.advanceProgress()
        }
      }),
    )
  }

  private async syncWithConversationInfo() {
    const conversations = this.sweepOrder(this.database.conversations())
    this.setStatus({ total: conversations.length })
    await Promise.all(
      conversations.map(async ({ conversation }) => {
        if (this.stopped) return
        try {
          const info = await this.client.call<{ channel: RawConversation }>('conversations.info', {
            channel: conversation.id,
          })
          const lastRead = info.channel.last_read ?? '0'
          this.database.setReadStates([[conversation.id, lastRead]])
          await this.fetchUnreadWindow(conversation.id, lastRead)
        } catch (error) {
          console.warn(`Could not sync ${conversation.name}`, error)
        } finally {
          this.advanceProgress()
        }
      }),
    )
  }

  private sweepOrder(conversations: StoredConversation[]): StoredConversation[] {
    const unread = (stored: StoredConversation) =>
      stored.newestTs !== undefined && stored.lastRead !== undefined && stored.newestTs > stored.lastRead ? 0 : 1
    return [...conversations].sort(
      (a, b) =>
        KIND_PRIORITY[a.conversation.kind] - KIND_PRIORITY[b.conversation.kind] ||
        unread(a) - unread(b) ||
        (b.newestTs ?? '').localeCompare(a.newestTs ?? ''),
    )
  }

  private async fetchUnreadWindow(channel: string, lastRead: string, latest?: string) {
    const result = await this.client.call<{ messages: Message[]; has_more?: boolean }>('conversations.history', {
      channel,
      oldest: lastRead,
      limit: HISTORY_LIMIT,
    })
    this.database.replaceHistoryWindow(channel, lastRead, result.messages.map(toMessage), !result.has_more, latest)
    this.changed()
  }

  private requestMissingUsers(ids: string[]) {
    if (!this.database.getMetadata<number>('users_synced_at')) return
    for (const id of ids) {
      if (this.requestedUsers.has(id)) continue
      this.requestedUsers.add(id)
      this.client
        .call<{ user: RawUser }>('users.info', { user: id })
        .then((result) => {
          this.database.upsertUser(toUser(result.user))
          this.changed()
        })
        .catch(() => undefined)
    }
  }

  private advanceProgress() {
    this.setStatus({ done: this.status.done + 1 })
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch }
    this.changed()
  }

  private changed() {
    this.version++
    if (this.notifyTimer || this.stopped) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      for (const listener of this.listeners) listener(this.version)
    }, CHANGE_NOTIFICATION_DELAY)
  }
}
