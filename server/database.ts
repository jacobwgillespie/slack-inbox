import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { compareTs } from '../src/slack/timestamps.ts'
import type { CachedConversation } from '../src/slack/dm-cache.ts'
import type { WebviewConversation, WebviewMessage } from '../src/slack/webview.ts'
import type {
  Classification,
  ClassificationLabel,
  Conversation,
  DirectMessage,
  ConversationSummary,
  ConversationKind,
  InboxItem,
  LaterItem,
  Message,
  SavedItemReference,
  SlackFile,
  User,
} from '../src/slack/types.ts'

const IGNORED_SUBTYPES = ['channel_join', 'channel_leave', 'group_join', 'group_leave']

function preserveHuddleText(previous: Message | undefined, message: Message): Message {
  // Slack's API can omit the description supplied by its rendered huddle card.
  if ((message.subtype ?? previous?.subtype) === 'huddle_thread' && !message.text.trim() && previous?.text.trim()) {
    return { ...message, text: previous.text }
  }
  return message
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS image_previews (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, data BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS emoji (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    is_member INTEGER NOT NULL DEFAULT 1,
    last_read TEXT,
    history_latest TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    thread_ts TEXT,
    user_id TEXT,
    subtype TEXT,
    data TEXT NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  );
  CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (conversation_id, thread_ts);
  CREATE TABLE IF NOT EXISTS history_ranges (
    conversation_id TEXT NOT NULL,
    oldest TEXT NOT NULL,
    newest TEXT NOT NULL,
    PRIMARY KEY (conversation_id, oldest)
  );
  CREATE TABLE IF NOT EXISTS webview_history (
    channel TEXT PRIMARY KEY,
    complete INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    error TEXT,
    oldest TEXT,
    newest TEXT
  );
  CREATE TABLE IF NOT EXISTS threads (
    conversation_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    last_read TEXT NOT NULL,
    PRIMARY KEY (conversation_id, thread_ts)
  );
  CREATE TABLE IF NOT EXISTS classifications (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    label TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT,
    previous_label TEXT,
    reviewed INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  );
  CREATE TABLE IF NOT EXISTS classification_attempts (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saved_items (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    state TEXT NOT NULL,
    date_created INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  );
`

const COLUMN_MIGRATIONS = [
  { table: 'conversations', column: 'done_ts', definition: 'TEXT' },
  { table: 'webview_history', column: 'oldest', definition: 'TEXT' },
  { table: 'webview_history', column: 'newest', definition: 'TEXT' },
  { table: 'conversations', column: 'is_muted', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'conversations', column: 'latest_ts', definition: 'TEXT' },
]

export type SavedItemState = 'in_progress' | 'completed'

export interface SavedItemRecord extends SavedItemReference {
  state: SavedItemState
  dateCreated: number
}

export interface LaterResult {
  items: LaterItem[]
  missing: SavedItemReference[]
}

interface ClassificationRow {
  conversation_id: string
  ts: string
  label: ClassificationLabel
  reason: string
  source: Classification['source']
}

export interface ThreadRecord {
  channel: string
  threadTs: string
  lastRead: string
}

interface ThreadInboxRow {
  conversation: string
  root: string
  message: string
  thread_ts: string
}

interface LaterRow {
  conversation_id: string
  ts: string
  date_created: number
  conversation: string | null
  message: string | null
}

export interface StoredConversation {
  conversation: Conversation
  lastRead?: string
  historyLatest?: string
  newestTs?: string
}

interface ConversationRow {
  data: string
  last_read: string | null
  history_latest: string | null
  newest_ts: string | null
}

interface InboxRow {
  conversation: string
  message: string
}

const topLevel = (prefix = '') =>
  `(${prefix}thread_ts IS NULL OR ${prefix}thread_ts = ${prefix}ts OR ${prefix}subtype = 'thread_broadcast')`

export class Database {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.migrateColumns()
  }

  private migrateColumns() {
    for (const { table, column, definition } of COLUMN_MIGRATIONS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (!columns.some((existing) => existing.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      }
    }
  }

  close() {
    this.db.close()
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  clearWorkspace() {
    this.transaction(() => {
      const tables = [
        'metadata',
        'users',
        'emoji',
        'conversations',
        'messages',
        'files',
        'image_previews',
        'history_ranges',
        'webview_history',
        'saved_items',
        'threads',
        'classifications',
        'classification_attempts',
      ]
      for (const table of tables) {
        this.db.exec(`DELETE FROM ${table}`)
      }
    })
  }

  getMetadata<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  setMetadata(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  replaceUsers(users: User[]) {
    this.transaction(() => {
      this.db.exec('DELETE FROM users')
      const insert = this.db.prepare('INSERT INTO users (id, data) VALUES (?, ?)')
      for (const user of users) insert.run(user.id, JSON.stringify(user))
    })
  }

  upsertUser(user: User) {
    this.db
      .prepare('INSERT INTO users (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data')
      .run(user.id, JSON.stringify(user))
  }

  usersById(ids: string[]): Record<string, User> {
    if (!ids.length) return {}
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(`SELECT data FROM users WHERE id IN (${placeholders})`).all(...ids) as { data: string }[]
    const users = rows.map((row) => JSON.parse(row.data) as User)
    return Object.fromEntries(users.map((user) => [user.id, user]))
  }

  replaceEmoji(emoji: Record<string, string>) {
    this.transaction(() => {
      this.db.exec('DELETE FROM emoji')
      const insert = this.db.prepare('INSERT INTO emoji (name, value) VALUES (?, ?)')
      for (const [name, value] of Object.entries(emoji)) insert.run(name, value)
    })
  }

  emoji(): Record<string, string> {
    const rows = this.db.prepare('SELECT name, value FROM emoji').all() as { name: string; value: string }[]
    return Object.fromEntries(rows.map((row) => [row.name, row.value]))
  }

  replaceConversations(conversations: Conversation[]) {
    this.transaction(() => {
      this.db.exec('UPDATE conversations SET is_member = 0')
      const upsert = this.db.prepare(
        `INSERT INTO conversations (id, data, is_member) VALUES (?, ?, 1)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data, is_member = 1`,
      )
      for (const conversation of conversations) upsert.run(conversation.id, JSON.stringify(conversation))
    })
  }

  conversations(): StoredConversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.data, c.last_read, c.history_latest,
           (SELECT MAX(m.ts) FROM messages m WHERE m.conversation_id = c.id AND ${topLevel('m.')}) AS newest_ts
         FROM conversations c WHERE c.is_member = 1`,
      )
      .all() as unknown as ConversationRow[]
    return rows.map((row) => ({
      conversation: JSON.parse(row.data) as Conversation,
      lastRead: row.last_read ?? undefined,
      historyLatest: row.history_latest ?? undefined,
      newestTs: row.newest_ts ?? undefined,
    }))
  }

  setReadStates(states: [id: string, lastRead: string][]) {
    this.transaction(() => {
      const update = this.db.prepare('UPDATE conversations SET last_read = ? WHERE id = ?')
      for (const [id, lastRead] of states) update.run(lastRead, id)
    })
  }

  setLatestStates(states: [id: string, ts: string][]) {
    this.transaction(() => {
      const update = this.db.prepare('UPDATE conversations SET latest_ts = ? WHERE id = ?')
      for (const [id, ts] of states) update.run(ts, id)
    })
  }

  doneConversations(): Record<string, string> {
    const rows = this.db.prepare('SELECT id, done_ts FROM conversations WHERE is_member = 1 AND done_ts IS NOT NULL')
      .all() as { id: string; done_ts: string }[]
    return Object.fromEntries(rows.map((row) => [row.id, row.done_ts]))
  }

  setDone(channel: string, ts?: string) {
    this.db.prepare('UPDATE conversations SET done_ts = ? WHERE id = ?').run(ts ?? null, channel)
  }

  directMessages(channel?: string): DirectMessage[] {
    return this.conversationSummaries(channel, ['dm', 'group'])
  }

  channels(): ConversationSummary[] {
    return this.conversationSummaries(undefined, ['channel', 'private'])
  }

  conversationSummaries(channel?: string, kinds: ConversationKind[] = ['dm', 'group', 'channel', 'private']): ConversationSummary[] {
    const rows = this.db.prepare(
      `SELECT c.id, c.data, c.last_read, c.latest_ts,
         (SELECT m.data FROM messages m WHERE m.conversation_id = c.id AND ${topLevel('m.')}
          ORDER BY m.ts DESC LIMIT 1) AS message
       FROM conversations c WHERE c.is_member = 1 AND json_extract(c.data, '$.kind') IN (${kinds.map(() => '?').join(', ')})
       ${channel ? 'AND c.id = ?' : ''}`,
    ).all(...kinds, ...(channel ? [channel] : [])) as { id: string; data: string; last_read: string | null; latest_ts: string | null; message: string | null }[]
    return rows.map((row) => {
      const message = row.message ? JSON.parse(row.message) as Message : undefined
      return {
        id: row.id,
        conversation: JSON.parse(row.data) as Conversation,
        messages: message ? [message] : [],
        lastRead: row.last_read ?? undefined,
        latestTs: row.latest_ts && compareTs(row.latest_ts, message?.ts ?? '0') > 0 ? row.latest_ts : message?.ts ?? '0',
      }
    })
  }

  historyMessages(channel: string, oldest: string, before?: string, limit = 101, newest?: string): Message[] {
    const rows = this.db.prepare(
      `SELECT data FROM messages WHERE conversation_id = ? AND ts >= ? AND ${topLevel()}
       ${before ? 'AND ts < ?' : ''} ${newest ? 'AND ts <= ?' : ''} ORDER BY ts DESC LIMIT ?`,
    ).all(channel, oldest, ...(before ? [before] : []), ...(newest ? [newest] : []), limit) as { data: string }[]
    return rows.map((row) => JSON.parse(row.data) as Message)
  }

  replaceHistoryWindow(conversationId: string, oldest: string, messages: Message[], complete: boolean, latest?: string) {
    const returned = messages.map((message) => message.ts).sort(compareTs)
    const windowStart = complete ? oldest : returned[0]
    this.transaction(() => {
      messages = this.preserveHuddleDescriptions(conversationId, messages)
      if (windowStart !== undefined) {
        const comparison = complete ? '>' : '>='
        this.db
          .prepare(`DELETE FROM messages WHERE conversation_id = ? AND ts ${comparison} ? AND ${topLevel()}`)
          .run(conversationId, windowStart)
      }
      this.insertMessages(conversationId, messages)
      this.db
        .prepare('UPDATE conversations SET history_latest = ? WHERE id = ?')
        .run(latest ?? returned[returned.length - 1] ?? null, conversationId)
    })
  }

  upsertConversation(conversation: Conversation, isMember: boolean) {
    this.db
      .prepare(
        `INSERT INTO conversations (id, data, is_member) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
      )
      .run(conversation.id, JSON.stringify(conversation), isMember ? 1 : 0)
  }

  mutedConversationIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM conversations WHERE is_muted = 1').all() as { id: string }[]
    return rows.map((row) => row.id)
  }

  setMuted(id: string, muted: boolean) {
    this.db.prepare('UPDATE conversations SET is_muted = ? WHERE id = ?').run(muted ? 1 : 0, id)
  }

  replaceMuted(ids: Set<string>) {
    this.transaction(() => {
      this.db.exec('UPDATE conversations SET is_muted = 0')
      const update = this.db.prepare('UPDATE conversations SET is_muted = 1 WHERE id = ?')
      for (const id of ids) update.run(id)
    })
  }

  savedItem(channel: string, ts: string): SavedItemRecord | undefined {
    const row = this.db
      .prepare('SELECT state, date_created FROM saved_items WHERE conversation_id = ? AND ts = ?')
      .get(channel, ts) as { state: SavedItemState; date_created: number } | undefined
    return row && { channel, ts, state: row.state, dateCreated: row.date_created }
  }

  setSavedItem(item: SavedItemRecord) {
    this.db
      .prepare(
        `INSERT INTO saved_items (conversation_id, ts, state, date_created) VALUES (?, ?, ?, ?)
         ON CONFLICT (conversation_id, ts) DO UPDATE SET state = excluded.state, date_created = excluded.date_created`,
      )
      .run(item.channel, item.ts, item.state, item.dateCreated)
  }

  deleteSavedItem(channel: string, ts: string) {
    this.db.prepare('DELETE FROM saved_items WHERE conversation_id = ? AND ts = ?').run(channel, ts)
  }

  replaceInProgressSavedItems(items: SavedItemRecord[], keepCreatedAfter: number) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM saved_items WHERE state = 'in_progress' AND date_created < ?").run(keepCreatedAfter)
      for (const item of items) this.setSavedItem(item)
    })
  }

  later(): LaterResult {
    const rows = this.db
      .prepare(
        `SELECT s.conversation_id, s.ts, s.date_created, c.data AS conversation, m.data AS message
         FROM saved_items s
         LEFT JOIN conversations c ON c.id = s.conversation_id
         LEFT JOIN messages m ON m.conversation_id = s.conversation_id AND m.ts = s.ts
         WHERE s.state = 'in_progress'
         ORDER BY s.date_created DESC`,
      )
      .all() as unknown as LaterRow[]
    const result: LaterResult = { items: [], missing: [] }
    for (const row of rows) {
      if (!row.conversation || !row.message) {
        result.missing.push({ channel: row.conversation_id, ts: row.ts })
        continue
      }
      const conversation = JSON.parse(row.conversation) as Conversation
      result.items.push({
        id: `${row.conversation_id}:${row.ts}`,
        conversation,
        messages: [JSON.parse(row.message) as Message],
        ts: row.ts,
        savedAt: row.date_created * 1000,
      })
    }
    return result
  }

  classifications(conversationIds: string[]): Map<string, Classification> {
    const result = new Map<string, Classification>()
    if (!conversationIds.length) return result
    const placeholders = conversationIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT conversation_id, ts, label, reason, source FROM classifications WHERE conversation_id IN (${placeholders})`,
      )
      .all(...conversationIds) as unknown as ClassificationRow[]
    for (const row of rows) {
      result.set(`${row.conversation_id}:${row.ts}`, { label: row.label, reason: row.reason, source: row.source })
    }
    return result
  }

  saveUserClassification(reference: SavedItemReference, label: ClassificationLabel) {
    const existing = this.db
      .prepare('SELECT label, source, previous_label FROM classifications WHERE conversation_id = ? AND ts = ?')
      .get(reference.channel, reference.ts) as
      | { label: ClassificationLabel; source: string; previous_label: ClassificationLabel | null }
      | undefined
    const previousLabel = existing?.source === 'user' ? existing.previous_label : (existing?.label ?? null)
    this.db
      .prepare(
        `INSERT INTO classifications (conversation_id, ts, label, reason, source, previous_label, reviewed, created_at)
         VALUES (?, ?, ?, 'Set by you', 'user', ?, 0, ?)
         ON CONFLICT (conversation_id, ts) DO UPDATE SET
           label = excluded.label, reason = excluded.reason, source = 'user',
           previous_label = excluded.previous_label, reviewed = 0, created_at = excluded.created_at`,
      )
      .run(reference.channel, reference.ts, label, previousLabel, Date.now())
  }

  restoreClassification(reference: SavedItemReference, classification: Classification | null) {
    if (!classification) {
      this.db
        .prepare('DELETE FROM classifications WHERE conversation_id = ? AND ts = ?')
        .run(reference.channel, reference.ts)
      return
    }
    this.db
      .prepare(
        `INSERT INTO classifications (conversation_id, ts, label, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id, ts) DO UPDATE SET
           label = excluded.label, reason = excluded.reason, source = excluded.source,
           previous_label = NULL, reviewed = 1`,
      )
      .run(reference.channel, reference.ts, classification.label, classification.reason, classification.source, Date.now())
  }

  setThread({ channel, threadTs, lastRead }: ThreadRecord) {
    this.db
      .prepare(
        `INSERT INTO threads (conversation_id, thread_ts, last_read) VALUES (?, ?, ?)
         ON CONFLICT (conversation_id, thread_ts) DO UPDATE SET last_read = excluded.last_read`,
      )
      .run(channel, threadTs, lastRead)
  }

  setThreadLastRead(channel: string, threadTs: string, lastRead: string) {
    this.db
      .prepare('UPDATE threads SET last_read = ? WHERE conversation_id = ? AND thread_ts = ?')
      .run(lastRead, channel, threadTs)
  }

  deleteThread(channel: string, threadTs: string) {
    this.db.prepare('DELETE FROM threads WHERE conversation_id = ? AND thread_ts = ?').run(channel, threadTs)
  }

  hasThread(channel: string, threadTs: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM threads WHERE conversation_id = ? AND thread_ts = ?').get(channel, threadTs) !==
      undefined
    )
  }

  applyThreadView(threads: ThreadRecord[], messages: [channel: string, message: Message][], complete: boolean) {
    this.transaction(() => {
      for (const thread of threads) this.setThread(thread)
      for (const [channel, message] of messages) this.insertMessages(channel, [message])
      if (!complete) return
      const returned = new Set(threads.map((thread) => `${thread.channel}:${thread.threadTs}`))
      const rows = this.db.prepare('SELECT conversation_id, thread_ts FROM threads').all() as {
        conversation_id: string
        thread_ts: string
      }[]
      const markRead = this.db.prepare(
        `UPDATE threads SET last_read = COALESCE(
           (SELECT MAX(ts) FROM messages WHERE conversation_id = threads.conversation_id AND thread_ts = threads.thread_ts),
           last_read)
         WHERE conversation_id = ? AND thread_ts = ?`,
      )
      for (const row of rows) {
        if (!returned.has(`${row.conversation_id}:${row.thread_ts}`)) markRead.run(row.conversation_id, row.thread_ts)
      }
    })
  }

  threadInbox(selfId: string): InboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT c.data AS conversation, root.data AS root, m.data AS message, t.thread_ts
         FROM threads t
         JOIN conversations c ON c.id = t.conversation_id
         JOIN messages root ON root.conversation_id = t.conversation_id AND root.ts = t.thread_ts
         JOIN messages m ON m.conversation_id = t.conversation_id AND m.thread_ts = t.thread_ts AND m.ts <> t.thread_ts
         WHERE m.ts > t.last_read AND COALESCE(m.user_id, '') <> ?
         ORDER BY t.conversation_id, t.thread_ts, m.ts`,
      )
      .all(selfId) as unknown as ThreadInboxRow[]

    const items = new Map<string, InboxItem>()
    for (const row of rows) {
      const conversation = JSON.parse(row.conversation) as Conversation
      const id = `thread:${conversation.id}:${row.thread_ts}`
      const item = items.get(id) ?? {
        id,
        conversation,
        messages: [],
        thread: { ts: row.thread_ts, root: JSON.parse(row.root) as Message },
      }
      item.messages.push(JSON.parse(row.message) as Message)
      items.set(id, item)
    }
    return [...items.values()]
  }

  hasAnyConversation(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id) !== undefined
  }

  hasConversation(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM conversations WHERE id = ? AND is_member = 1').get(id) !== undefined
  }

  message(conversationId: string, ts: string): Message | undefined {
    const row = this.db
      .prepare('SELECT data FROM messages WHERE conversation_id = ? AND ts = ?')
      .get(conversationId, ts) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as Message) : undefined
  }

  deleteMessage(conversationId: string, ts: string) {
    this.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND ts = ?').run(conversationId, ts)
  }

  upsertMessages(conversationId: string, messages: Message[]) {
    this.transaction(() => this.insertMessages(conversationId, messages.map((message) => {
      const previous = this.message(conversationId, message.ts)
      return preserveHuddleText(previous, { ...previous, ...message })
    })))
  }

  cacheWebview(snapshot: WebviewConversation): boolean {
    let changed = false
    this.transaction(() => {
      for (const message of snapshot.messages) {
        const previous = this.message(snapshot.channel, message.ts)
        // API reaction snapshots include users. Keep them when a rendered Slack
        // timeline still shows the old reaction state.
        const reactions = previous?.reactions?.every((reaction) => reaction.users !== undefined)
          ? previous.reactions : message.reactions
        const next = preserveHuddleText(previous, { ...previous, ...message, reactions, user: message.user ?? previous?.user, username: message.username ?? previous?.username })
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
          this.insertMessages(snapshot.channel, [next])
          changed = true
        }
      }
      this.db.prepare(`INSERT INTO webview_history (channel, complete, updated_at, oldest, newest) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(channel) DO UPDATE SET complete = MAX(complete, excluded.complete), updated_at = excluded.updated_at, error = NULL, oldest = CASE WHEN oldest IS NULL THEN excluded.oldest WHEN excluded.oldest IS NULL THEN oldest ELSE MIN(oldest, excluded.oldest) END,
          newest = CASE WHEN newest IS NULL THEN excluded.newest WHEN excluded.newest IS NULL THEN newest ELSE MAX(newest, excluded.newest) END`)
        .run(snapshot.channel, snapshot.hasMore ? 0 : 1, Date.now(), snapshot.messages[0]?.ts ?? null, snapshot.messages.at(-1)?.ts ?? null)
    })
    return changed
  }

  webviewFailure(channel: string, error: string) {
    this.db.prepare(`INSERT INTO webview_history (channel, updated_at, error) VALUES (?, 0, ?)
      ON CONFLICT(channel) DO UPDATE SET error = excluded.error`).run(channel, error)
  }

  cachedConversation(channel: string, before?: string, after?: string): CachedConversation {
    const state = this.db.prepare('SELECT complete, updated_at, error, oldest, newest FROM webview_history WHERE channel = ?')
      .get(channel) as { complete: number; updated_at: number; error: string | null; oldest: string | null; newest: string | null } | undefined
    const messages = this.historyMessages(channel, after ?? '0', before, after ? -1 : 101) as WebviewMessage[]
    const oldest = this.db.prepare(`SELECT MIN(ts) AS ts FROM messages WHERE conversation_id = ? AND ${topLevel()}`)
      .get(channel) as { ts: string | null }
    const page = (after ? messages : messages.slice(0, 100)).reverse()
    return { channel, messages: page, hasMore: (!after && messages.length > 100) || !state?.complete || Boolean(after && this.historyMessages(channel, '0', after, 1).length),
      collected: Boolean(state?.updated_at), complete: Boolean(state?.complete), newest: state?.newest ?? undefined, updatedAt: state?.updated_at, oldest: state?.oldest ?? oldest.ts ?? undefined, error: state?.error ?? undefined, syncing: false }
  }

  webviewImageKnown(source: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM messages m, json_each(m.data, '$.images') i
      WHERE json_extract(i.value, '$.src') = ? LIMIT 1`).get(source))
  }

  file(id: string): SlackFile | undefined {
    const row = this.db.prepare('SELECT data FROM files WHERE id = ?').get(id) as { data: string } | undefined
    if (row) return JSON.parse(row.data) as SlackFile
    // Older cached messages only retained the filename and Slack link.
    const legacy = this.db.prepare(
      `SELECT f.value AS data FROM messages m, json_each(m.data, '$.files') f
       WHERE json_extract(f.value, '$.id') = ? LIMIT 1`,
    ).get(id) as { data: string } | undefined
    return legacy ? JSON.parse(legacy.data) as SlackFile : undefined
  }

  cacheFile(file: SlackFile) {
    const row = this.db.prepare('SELECT data FROM files WHERE id = ?').get(file.id) as { data: string } | undefined
    const previous = row ? JSON.parse(row.data) as SlackFile : undefined
    const fields = Object.fromEntries(Object.entries(file).filter(([, value]) => value !== undefined))
    this.db.prepare('INSERT INTO files (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data')
      .run(file.id, JSON.stringify({ ...previous, ...fields }))
  }

  imagePreview(id: string): { contentType: string; data: Uint8Array } | undefined {
    const row = this.db.prepare('SELECT content_type, data FROM image_previews WHERE id = ?').get(id) as
      { content_type: string; data: Uint8Array } | undefined
    return row && { contentType: row.content_type, data: row.data }
  }

  cacheImagePreview(id: string, contentType: string, data: Uint8Array) {
    this.db.prepare('INSERT OR REPLACE INTO image_previews (id, content_type, data) VALUES (?, ?, ?)')
      .run(id, contentType, data)
  }

  inbox(selfId: string, messageLimit: number): InboxItem[] {
    const ignored = IGNORED_SUBTYPES.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT c.data AS conversation, m.data AS message
         FROM conversations c
         JOIN messages m ON m.conversation_id = c.id
         WHERE c.is_member = 1
           AND c.last_read IS NOT NULL
           AND m.ts > c.last_read
           AND ${topLevel('m.')}
           AND COALESCE(m.user_id, '') <> ?
           AND COALESCE(m.subtype, '') NOT IN (${ignored})
         ORDER BY c.id, m.ts`,
      )
      .all(selfId, ...IGNORED_SUBTYPES) as unknown as InboxRow[]

    const items = new Map<string, InboxItem>()
    for (const row of rows) {
      const conversation = JSON.parse(row.conversation) as Conversation
      const item = items.get(conversation.id) ?? { id: conversation.id, conversation, messages: [] }
      item.messages.push(JSON.parse(row.message) as Message)
      items.set(conversation.id, item)
    }
    for (const item of items.values()) item.messages = item.messages.slice(-messageLimit)
    return [...items.values()]
  }

  private preserveHuddleDescriptions(channel: string, messages: Message[]): Message[] {
    return messages.map((message) => message.subtype === 'huddle_thread' && !message.text.trim()
      ? preserveHuddleText(this.message(channel, message.ts), message)
      : message)
  }

  private insertMessages(conversationId: string, messages: Message[]) {
    const upsert = this.db.prepare(
      `INSERT INTO messages (conversation_id, ts, thread_ts, user_id, subtype, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, ts) DO UPDATE SET
         thread_ts = excluded.thread_ts, user_id = excluded.user_id, subtype = excluded.subtype, data = excluded.data`,
    )
    for (const message of messages) {
      upsert.run(
        conversationId,
        message.ts,
        message.thread_ts ?? null,
        message.user ?? null,
        message.subtype ?? null,
        JSON.stringify(message),
      )
      for (const file of message.files ?? []) this.cacheFile(file)
    }
  }
}
