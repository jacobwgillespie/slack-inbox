import { createCollection, localOnlyCollectionOptions } from '@tanstack/react-db'
import type { CachedConversation } from './slack/dm-cache'
import type { WebviewMessage } from './slack/webview'
import type { DirectMessage, ConversationSummary, InboxItem, LaterItem, User, Session, SyncStatus } from './slack/types'
import type { LocalApiError } from './api'

function local<T extends { id: string }>(id: string) {
  return createCollection(localOnlyCollectionOptions<T, string>({ id, getKey: (row) => row.id }))
}
export const dmCollection = local<DirectMessage>('dms')
export const channelCollection = local<ConversationSummary>('channels')
export const inboxCollection = local<InboxItem>('inbox')
export const laterCollection = local<LaterItem>('later')
export const userCollection = local<User>('users')
export const preferenceCollection = local<{ id: string; done?: string; muted: boolean; inboxMuted?: boolean }>('preferences')
export interface RuntimeData {
  id: string
  status: 'loading' | 'ready' | 'error'
  error?: LocalApiError
  session?: Session
  sync?: SyncStatus
  emoji: Record<string, string>
}
export const runtimeCollection = local<RuntimeData>('runtime')
runtimeCollection.insert({ id: 'slack', status: 'loading', emoji: {} })
type CachedMessage = WebviewMessage & { id: string; channel: string; pending?: boolean }
export const messageCollection = local<CachedMessage>('messages')
export const cacheCollection = local<Omit<CachedConversation, 'messages'> & { id: string }>('dm-cache')

// SQLite and the existing command layer publish confirmed snapshots here.
// Preserve unchanged objects so unrelated messages do not rerender.
export function reconcile<T extends { id: string }>(collection: ReturnType<typeof local<T>>, rows: NoInfer<T>[], replace = true) {
  const ids = new Set(rows.map((row) => row.id))
  for (const row of rows) {
    const previous = collection.get(row.id)
    if (!previous) collection.insert(row)
    else if (JSON.stringify(Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith('$')))) !== JSON.stringify(row)) {
      collection.update(row.id, (draft) => {
        for (const key of Object.keys(draft)) if (!(key in row)) delete (draft as Record<string, unknown>)[key]
        Object.assign(draft, row)
      })
    }
  }
  if (replace) for (const key of collection.keys()) if (!ids.has(key)) collection.delete(key)
}

export function reconcileMessages(rows: CachedMessage[]) {
  for (const message of rows) {
    if (!message.client_msg_id) continue
    for (const pending of messageCollection.values()) {
      if (pending.pending && pending.channel === message.channel && pending.client_msg_id === message.client_msg_id && pending.id !== message.id) messageCollection.delete(pending.id)
    }
  }
  reconcile(messageCollection, rows, false)
}

export function applyCache(snapshot: CachedConversation, replaceFrom?: string) {
  const { messages, deletedTs = [], ...state } = snapshot
  for (const ts of deletedTs) {
    const id = `${snapshot.channel}:${ts}`
    if (messageCollection.has(id)) messageCollection.delete(id)
  }
  reconcile(cacheCollection, [{ ...state, id: snapshot.channel }], false)
  const rows = messages.map((message) => ({ ...message, id: `${snapshot.channel}:${message.ts}`, channel: snapshot.channel }))
  if (replaceFrom) {
    const ids = new Set(rows.map((row) => row.id))
    for (const row of messageCollection.values()) {
      if (row.pending) continue
      // Channel history only includes top-level messages, so it cannot replace thread replies.
      if (row.thread_ts && row.thread_ts !== row.ts && row.subtype !== 'thread_broadcast') continue
      if (row.channel === snapshot.channel && row.ts >= replaceFrom && !ids.has(row.id)) messageCollection.delete(row.id)
    }
  }
  reconcileMessages(rows)
}
