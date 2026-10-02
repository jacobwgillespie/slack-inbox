import type { OutgoingMessage } from '../src/slack/rich-text.ts'
import type {
  InboxItem,
  ClassificationEntry,
  ClassificationLabel,
  InboxPayload,
  LegacyPreferences,
  SavedItemReference,
  Message,
  Session,
  SyncError,
  SyncStatus,
  ThreadPayload,
  TypingEvent,
  RealtimeEvent,
} from '../src/slack/types.ts'
import type { Database } from './database.ts'
import { Preferences } from './preferences.ts'
import { Threads } from './threads.ts'
import { Files } from './files.ts'
import { SlackError, type SlackClient } from './slack-client.ts'
import {
  hasUnreads,
  toConversation,
  toMessage,
  toUser,
  type RawConversation,
  type RawCount,
  type RawUser,
} from './slack-data.ts'

const SESSION_SYNC_INTERVAL = 30 * 1000
const REALTIME_SYNC_INTERVAL = 5 * 60 * 1000
const DIRECTORY_MAX_AGE = 60 * 60 * 1000
const HISTORY_LIMIT = 100
const INBOX_MESSAGE_LIMIT = 100
const CHANGE_NOTIFICATION_DELAY = 250
const USER_MENTION = /<@([UW][A-Z0-9]+)/g
const READ_MARKER_EVENTS = new Set(['channel_marked', 'group_marked', 'im_marked', 'mpim_marked'])
const MEMBERSHIP_EVENTS = new Set([
  'channel_joined',
  'channel_left',
  'channel_rename',
  'group_joined',
  'group_left',
  'group_rename',
  'im_created',
  'im_close',
  'mpim_joined',
  'mpim_close',
])

type DirectoryKey = 'conversations' | 'users' | 'emoji'

function describeError(error: unknown): SyncError {
  if (error instanceof SlackError) return { code: error.code, needed: error.needed, message: error.message }
  return { code: 'internal_error', message: error instanceof Error ? error.message : String(error) }
}

function messageUserIds(messages: Message[], ids = new Set<string>()): Set<string> {
  for (const message of messages) {
    if (message.user) ids.add(message.user)
    for (const match of message.text.matchAll(USER_MENTION)) if (match[1]) ids.add(match[1])
  }
  return ids
}

function referencedUserIds(items: InboxItem[]): string[] {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.conversation.userId) ids.add(item.conversation.userId)
    messageUserIds(item.messages, ids)
  }
  return [...ids]
}

export class SyncEngine {
  private readonly reactionRequests = new Map<string, Promise<unknown>>()
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
  private readonly typingListeners = new Set<(event: TypingEvent) => void>()
  private readonly requestedUsers = new Set<string>()
  private readonly preferences: Preferences
  private readonly threads: Threads
  private readonly files: Files

  constructor(
    private readonly database: Database,
    private readonly client: SlackClient,
  ) {
    this.status = {
      realtime: 'connecting',
      running: false,
      done: 0,
      total: 0,
    }
    this.files = new Files(database, client)
    this.session = database.getMetadata<boolean>('signed-out') ? undefined : database.getMetadata<Session>('session')
    this.preferences = new Preferences(database, client, () => this.changed())
    this.threads = new Threads(database, client, () => this.changed(), () => this.requestSync())
  }

  reauthenticate() {
    this.sessionVerified = false
    this.requestSync()
  }

  observeRealtime(event: RealtimeEvent) {
    this.handleRealtimeEvent(event)
  }

  setExternalRealtime(connected: boolean) {
    this.setStatus({ realtime: connected ? 'connected' : 'connecting' })
    if (connected) this.requestSync()
  }

  start() {
    this.requestSync()
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.notifyTimer)
    this.listeners.clear()
    this.typingListeners.clear()
    await this.running?.catch(() => undefined)
  }

  subscribe(listener: (version: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeTyping(listener: (event: TypingEvent) => void): () => void {
    this.typingListeners.add(listener)
    return () => this.typingListeners.delete(listener)
  }

  webviewChanged() { this.changed() }

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
      this.timer = setTimeout(() => this.requestSync(), this.syncInterval())
    })
  }

  inbox(): InboxPayload {
    const items = this.session
      ? [
          ...this.withClassifications(this.database.inbox(this.session.userId, INBOX_MESSAGE_LIMIT)),
          ...this.database.threadInbox(this.session.userId),
        ]
      : []
    const later = this.preferences.later()
    const directMessages = this.database.directMessages()
    const channels = this.database.channels()
    const ids = referencedUserIds([...items, ...later, ...directMessages, ...channels])
    if (this.session) ids.push(this.session.userId)
    const users = this.database.usersById(ids)
    this.requestMissingUsers(ids.filter((id) => !users[id]))
    return {
      version: this.version,
      session: this.session,
      sync: this.status,
      items,
      directMessages,
      channels,
      done: this.database.doneConversations(),
      later,
      muted: this.database.mutedConversationIds(),
      inboxMuted: this.database.inboxMutedIds(),
      users,
    }
  }

  setClassifications(references: SavedItemReference[], label: ClassificationLabel) {
    this.database.transaction(() => {
      for (const reference of references) this.database.saveUserClassification(reference, label)
    })
    this.changed()
  }

  restoreClassifications(entries: ClassificationEntry[]) {
    this.database.transaction(() => {
      for (const entry of entries) this.database.restoreClassification(entry, entry.classification)
    })
    this.changed()
  }

  private withClassifications(items: InboxItem[]): InboxItem[] {
    const classifications = this.database.classifications(items.map((item) => item.conversation.id))
    return items.map((item) => ({
      ...item,
      messages: item.messages.map((message) => {
        const classification = classifications.get(`${item.conversation.id}:${message.ts}`)
        return classification ? { ...message, classification } : message
      }),
    }))
  }

  async markThreadRead(channel: string, threadTs: string, ts: string) {
    await this.threads.markRead(channel, threadTs, ts)
  }

  saveForLater(channel: string, ts: string) {
    return this.preferences.save(channel, ts)
  }

  async addReaction(channel: string, ts: string, name: string) {
    try {
      await this.client.call('reactions.add', { channel, timestamp: ts, name })
    } catch (error) {
      if (!(error instanceof SlackError && error.code === 'already_reacted')) throw error
    }
    return this.refreshReactions(channel, ts)
  }

  async removeReaction(channel: string, ts: string, name: string) {
    try {
      await this.client.call('reactions.remove', { channel, timestamp: ts, name })
    } catch (error) {
      if (!(error instanceof SlackError && error.code === 'no_reaction')) throw error
    }
    return this.refreshReactions(channel, ts)
  }

  async reactionDetails(channel: string, ts: string) {
    const { reactions } = await this.refreshReactions(channel, ts)
    const users = await this.resolveUsers([...new Set(reactions.flatMap((reaction) => reaction.users ?? []))])
    return { reactions, users }
  }

  async cachedConversation(channel: string, before?: string, after?: string) {
    const snapshot = this.database.cachedConversation(channel, before, after)
    const users = await this.resolveUsers([...messageUserIds(snapshot.messages)])
    return { ...snapshot, users }
  }

  private async resolveUsers(ids: string[]) {
    const users = this.database.usersById(ids)
    await Promise.allSettled(ids.filter((id) => !users[id]).map(async (id) => {
      const result = await this.client.call<{ user: RawUser }>('users.info', { user: id })
      const user = toUser(result.user)
      this.database.upsertUser(user)
      users[id] = user
    }))
    return users
  }

  private refreshReactions(channel: string, ts: string) {
    const key = `${channel}:${ts}`
    const previous = this.reactionRequests.get(key) ?? Promise.resolve()
    const request = previous.catch(() => {}).then(async () => {
      const result = await this.client.call<{ message: Message }>('reactions.get', { channel, timestamp: ts, full: true })
      const reactions = toMessage(result.message).reactions ?? []
      const message = this.database.message(channel, ts)
      if (message) this.database.upsertMessages(channel, [{ ...message, reactions }])
      this.changed()
      return { reactions }
    }).finally(() => {
      if (this.reactionRequests.get(key) === request) this.reactionRequests.delete(key)
    })
    this.reactionRequests.set(key, request)
    return request
  }

  completeLater(channel: string, ts: string) {
    return this.preferences.complete(channel, ts)
  }

  reopenLater(channel: string, ts: string) {
    return this.preferences.reopen(channel, ts)
  }

  removeLater(channel: string, ts: string) {
    return this.preferences.remove(channel, ts)
  }

  setInboxMuted(channel: string, muted: boolean) {
    this.database.setInboxMuted(channel, muted)
    this.changed()
  }

  setMuted(channel: string, muted: boolean) {
    return this.preferences.setMuted(channel, muted)
  }

  importLegacyPreferences(preferences: LegacyPreferences) {
    return this.preferences.importLegacy(preferences)
  }

  emoji(): Record<string, string> {
    return this.database.emoji()
  }

  async setDone(channel: string, ts?: string, markRead = true) {
    if (!this.database.hasConversation(channel)) throw new SlackError('conversations.mark', 'channel_not_found')
    if (markRead && ts && ts !== '0') await this.markRead(channel, ts)
    this.database.setDone(channel, ts)
    this.changed()
  }

  async markRead(channel: string, ts: string) {
    await this.client.call('conversations.mark', { channel, ts })
    this.database.setReadStates([[channel, ts]])
    this.changed()
  }

  async postMessage(channel: string, message: OutgoingMessage, threadTs?: string) {
    const blocks = message.gif
      ? [...(message.blocks ?? []), { type: 'image', image_url: message.gif.url, alt_text: message.gif.title }]
      : message.blocks
    const result = await this.client.call<{ message?: Message }>('chat.postMessage', {
      channel,
      text: message.text,
      thread_ts: threadTs,
      blocks: blocks ? JSON.stringify(blocks) : undefined,
      client_msg_id: message.clientMsgId,
    })
    if (result.message) {
      this.database.upsertMessages(channel, [toMessage(result.message)])
    }
    this.changed()
    return result.message?.ts
  }

  async threadReplies(channel: string, ts: string): Promise<ThreadPayload> {
    const raw = await this.client.paginate<Message>('conversations.replies', 'messages', { channel, ts, limit: 200 })
    const all = raw.map(toMessage)
    this.database.upsertMessages(channel, all)
    const messages = all.filter((message) => message.ts !== ts)
    const users = await this.resolveUsers([...messageUserIds(all)])
    return { root: all.find((message) => message.ts === ts), messages, users }
  }

  imagePreview(id: string) {
    return this.files.image(id)
  }

  private syncInterval() {
    if (this.status.realtime === 'connected') return REALTIME_SYNC_INTERVAL
    return SESSION_SYNC_INTERVAL
  }

  private handleRealtimeEvent(event: RealtimeEvent) {
    const channel = typeof event.channel === 'string' ? event.channel : undefined
    if (channel && typeof event.user === 'string' && event.user !== this.session?.userId &&
        (event.type === 'user_typing' || (event.type === 'message' && !event.subtype))) {
      const typing = { channel, user: event.user, active: event.type === 'user_typing' }
      for (const listener of this.typingListeners) listener(typing)
    }
    if (event.type === 'message' && channel) {
      this.handleMessageEvent(channel, event)
    } else if (READ_MARKER_EVENTS.has(event.type) && channel && typeof event.ts === 'string') {
      this.database.setReadStates([[channel, event.ts]])
    } else if (event.type === 'reaction_added' || event.type === 'reaction_removed') {
      this.handleReactionEvent(event)
    } else if (event.type === 'user_change' && event.user && typeof event.user === 'object') {
      this.database.upsertUser(toUser(event.user as RawUser))
    } else if (MEMBERSHIP_EVENTS.has(event.type)) {
      this.invalidateDirectory('conversations')
    } else if (this.threads.handleEvent(event)) {
      return
    } else if (event.type === 'pref_change' && event.name === 'all_notifications_prefs') {
      this.preferences.applyNotificationPreferences(event.value)
      return
    } else if (event.type === 'emoji_changed') {
      this.invalidateDirectory('emoji')
    } else {
      return
    }
    this.changed()
  }

  private handleMessageEvent(channel: string, event: RealtimeEvent) {
    if (!this.database.hasConversation(channel)) {
      this.invalidateDirectory('conversations')
      return
    }
    switch (event.subtype) {
      case 'message_deleted':
        if (typeof event.deleted_ts === 'string') this.database.deleteMessage(channel, event.deleted_ts)
        return
      case 'message_changed':
      case 'message_replied':
        if (event.message && typeof event.message === 'object') {
          this.database.upsertMessages(channel, [toMessage(event.message as Message)])
        }
        return
      default:
        if (typeof event.ts === 'string') {
          this.database.upsertMessages(channel, [toMessage(event as unknown as Message)])
        }
    }
  }

  private handleReactionEvent(event: RealtimeEvent) {
    const item = event.item as { channel?: string; ts?: string } | undefined
    if (!item?.channel || !item.ts || !this.database.message(item.channel, item.ts)) return
    void this.refreshReactions(item.channel, item.ts).catch(console.error)
  }

  private invalidateDirectory(key: DirectoryKey) {
    this.database.setMetadata(`${key}_synced_at`, 0)
    this.requestSync()
  }

  private async runSync() {
    this.setStatus({ running: true, done: 0, total: 0, error: undefined })
    try {
      await this.ensureSession()
      await this.refreshDirectory('conversations')
      await this.syncWithCounts()
      await this.threads.sync().catch((error) => console.warn('Could not sync threads', error))
      await this.preferences.sync().catch((error) => console.warn('Could not sync Later and mute settings', error))
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
    if (this.sessionVerified) return
    const result = await this.client.call<{ user_id: string; user: string; team_id: string; url: string }>('auth.test')
    const session = { userId: result.user_id, handle: result.user, teamId: result.team_id, url: result.url }
    const previousSession = this.session ?? this.database.getMetadata<Session>('session')
    if (previousSession && (previousSession.userId !== session.userId || previousSession.teamId !== session.teamId)) {
      this.database.clearWorkspace()
    }
    this.session = session
    this.sessionVerified = true
    this.database.setMetadata('session', session)
    this.database.setMetadata('signed-out', false)
    await this.client.call<{ user: RawUser }>('users.info', { user: session.userId })
      .then(({ user }) => this.database.upsertUser(toUser(user)))
      .catch((error) => console.warn('Could not refresh your Slack profile', error))
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
    this.database.setLatestStates(tracked.flatMap((count) => count.latest ? [[count.id, count.latest]] : []))
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
