import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { compareTs } from '../src/slack/timestamps.ts'
import type { Conversation, InboxItem, Message, User } from '../src/slack/types.ts'

const IGNORED_SUBTYPES = ['channel_join', 'channel_leave', 'group_join', 'group_leave']

const SCHEMA = `
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
`

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
      for (const table of ['metadata', 'users', 'emoji', 'conversations', 'messages']) this.db.exec(`DELETE FROM ${table}`)
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

  replaceHistoryWindow(conversationId: string, oldest: string, messages: Message[], complete: boolean, latest?: string) {
    const returned = messages.map((message) => message.ts).sort(compareTs)
    const windowStart = complete ? oldest : returned[0]
    this.transaction(() => {
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
    this.transaction(() => this.insertMessages(conversationId, messages))
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
      const item = items.get(conversation.id) ?? { conversation, messages: [] }
      item.messages.push(JSON.parse(row.message) as Message)
      items.set(conversation.id, item)
    }
    for (const item of items.values()) item.messages = item.messages.slice(-messageLimit)
    return [...items.values()]
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
    }
  }
}
