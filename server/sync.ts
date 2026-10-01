import type {
  ConversationKind,
  CredentialMode,
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
  HistoryPayload,
  TypingEvent,
} from '../src/slack/types.ts'
import { Classifier, type ClassifierOptions } from './classifier.ts'
import type { Database, StoredConversation } from './database.ts'
import { Preferences } from './preferences.ts'
import { Threads } from './threads.ts'
import { History } from './history.ts'
import { Files } from './files.ts'
import { RealtimeConnection, type RealtimeEvent } from './realtime.ts'
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
const USER_SYNC_INTERVAL = 60 * 1000
const DIRECTORY_MAX_AGE = 60 * 60 * 1000
const HISTORY_LIMIT = 100
const INBOX_MESSAGE_LIMIT = 100
const CHANGE_NOTIFICATION_DELAY = 250
const KIND_PRIORITY: Record<ConversationKind, number> = { dm: 0, group: 1, private: 2, channel: 3 }
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
  private readonly realtime?: RealtimeConnection
  private readonly preferences: Preferences
  private readonly threads?: Threads
  private readonly classifier?: Classifier
  private readonly messageHistory: History
  private readonly files: Files

  constructor(
    private readonly database: Database,
    private readonly client: SlackClient,
    mode: CredentialMode,
    classifierOptions?: ClassifierOptions,
    externalRealtime = false,
  ) {
    this.status = {
      mode,
      realtime: mode === 'session' ? 'connecting' : 'unavailable',
      classifier: { enabled: Boolean(classifierOptions), running: false, pending: 0 },
      running: false,
      done: 0,
      total: 0,
    }
    this.messageHistory = new History(database, client)
    this.files = new Files(database, client)
    if (classifierOptions) {
      this.classifier = new Classifier(database, classifierOptions, {
        session: () => this.session,
        unreadItems: () => (this.session ? this.database.inbox(this.session.userId, INBOX_MESSAGE_LIMIT) : []),
        onStatus: (classifier) => this.setStatus({ classifier }),
        changed: () => this.changed(),
      })
    }
    this.session = database.getMetadata<boolean>('signed-out') ? undefined : database.getMetadata<Session>('session')
    this.preferences = new Preferences(database, client, mode === 'session', () => this.changed())
    if (mode === 'session') {
      this.threads = new Threads(
        database,
        client,
        () => this.changed(),
        () => this.requestSync(),
      )
      if (!externalRealtime) this.realtime = new RealtimeConnection(client, {
        onEvent: (event) => this.handleRealtimeEvent(event),
        onStateChange: (realtime) => {
          if (realtime !== 'connected') this.messageHistory.invalidateLive()
          this.setStatus({ realtime })
        },
        onConnected: () => this.requestSync(),
      })
    }
  }

  reauthenticate() {
    this.sessionVerified = false
    this.requestSync()
  }

  observeRealtime(event: RealtimeEvent) {
    this.handleRealtimeEvent(event)
  }

  setExternalRealtime(connected: boolean) {
    if (!connected) this.messageHistory.invalidateLive()
    this.setStatus({ realtime: connected ? 'connected' : 'connecting' })
    if (connected) this.requestSync()
  }

  start() {
    this.requestSync()
    this.realtime?.start()
  }

  async stop() {
    this.stopped = true
    this.realtime?.stop()
    await this.classifier?.stop()
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
          ...(this.threads ? this.database.threadInbox(this.session.userId) : []),
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
      preferenceSource: this.preferences.source,
      users,
    }
  }

  setClassifications(references: SavedItemReference[], label: ClassificationLabel) {
    this.database.transaction(() => {
      for (const reference of references) this.database.saveUserClassification(reference, label)
    })
    this.changed()
    this.classifier?.schedule()
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
    if (!this.threads) throw new SlackError('subscriptions.thread.mark', 'not_allowed_token_type')
    await this.threads.markRead(channel, threadTs, ts)
  }

  saveForLater(channel: string, ts: string) {
    return this.preferences.save(channel, ts)
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

  async postMessage(channel: string, text: string, threadTs?: string) {
    const result = await this.client.call<{ message?: Message }>('chat.postMessage', {
      channel,
      text,
      thread_ts: threadTs,
    })
    if (result.message) {
      this.database.upsertMessages(channel, [toMessage(result.message)])
      this.messageHistory.observeMessage(channel, result.message.ts)
    }
    this.changed()
  }

  async threadReplies(channel: string, ts: string): Promise<ThreadPayload> {
    const raw = await this.client.paginate<Message>('conversations.replies', 'messages', { channel, ts, limit: 200 })
    const all = raw.map(toMessage)
    this.database.upsertMessages(channel, all)
    const messages = all.filter((message) => message.ts !== ts)
    const ids = [...messageUserIds(messages)]
    const users = this.database.usersById(ids)
    this.requestMissingUsers(ids.filter((id) => !users[id]))
    return { messages, users }
  }

  imagePreview(id: string) {
    return this.files.image(id)
  }

  async history(channel: string, options: { before?: string; after?: string; cached?: boolean }): Promise<HistoryPayload> {
    const page = await this.messageHistory.page(channel, {
      ...options,
      maxAge: this.status.realtime === 'connected' ? REALTIME_SYNC_INTERVAL : USER_SYNC_INTERVAL,
      live: this.status.realtime === 'connected',
    })
    const ids = [...messageUserIds(page.messages)]
    const users = this.database.usersById(ids)
    this.requestMissingUsers(ids.filter((id) => !users[id]))
    if (!options.cached) this.changed()
    return { ...page, users }
  }

  private syncInterval() {
    if (this.status.realtime === 'connected') return REALTIME_SYNC_INTERVAL
    return this.status.mode === 'session' ? SESSION_SYNC_INTERVAL : USER_SYNC_INTERVAL
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
    } else if (this.threads?.handleEvent(event)) {
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
          if (!event.thread_ts || event.thread_ts === event.ts || event.subtype === 'thread_broadcast') {
            this.messageHistory.observeMessage(channel, event.ts)
          }
          this.classifier?.schedule()
        }
    }
  }

  private handleReactionEvent(event: RealtimeEvent) {
    const item = event.item as { channel?: string; ts?: string } | undefined
    const name = typeof event.reaction === 'string' ? event.reaction : undefined
    if (!item?.channel || !item.ts || !name) return
    const message = this.database.message(item.channel, item.ts)
    if (!message) return
    const delta = event.type === 'reaction_added' ? 1 : -1
    const reactions = message.reactions ?? []
    const existing = reactions.find((reaction) => reaction.name === name)
    const updated = existing
      ? reactions.map((reaction) => (reaction === existing ? { name, count: reaction.count + delta } : reaction))
      : delta > 0
        ? [...reactions, { name, count: 1 }]
        : reactions
    const next = { ...message, reactions: updated.filter((reaction) => reaction.count > 0) }
    this.database.upsertMessages(item.channel, [next])
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
      if (this.status.mode === 'session') await this.syncWithCounts()
      else await this.syncWithConversationInfo()
      await this.threads?.sync().catch((error) => console.warn('Could not sync threads', error))
      await this.preferences.sync().catch((error) => console.warn('Could not sync Later and mute settings', error))
      await this.refreshDirectory('users')
      await this.refreshDirectory('emoji').catch(() => undefined)
      this.setStatus({ lastCompletedAt: Date.now() })
      this.classifier?.schedule(0)
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
    const previousSession = this.session ?? this.database.getMetadata<Session>('session')
    if (previousSession && (previousSession.userId !== session.userId || previousSession.teamId !== session.teamId)) {
      this.database.clearWorkspace()
    }
    this.session = session
    this.sessionVerified = true
    this.database.setMetadata('session', session)
    this.database.setMetadata('signed-out', false)
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
