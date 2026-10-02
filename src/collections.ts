import { createCollection, localOnlyCollectionOptions } from '@tanstack/react-db'
import type { CachedConversation } from './slack/dm-cache'
import type { WebviewMessage } from './slack/webview'
import type { DirectMessage, ConversationSummary, InboxItem, LaterItem, User } from './slack/types'

function local<T extends { id: string }>(id: string) {
  return createCollection(localOnlyCollectionOptions<T, string>({ id, getKey: (row) => row.id }))
}
export const dmCollection = local<DirectMessage>('dms')
export const channelCollection = local<ConversationSummary>('channels')
export const inboxCollection = local<InboxItem>('inbox')
export const laterCollection = local<LaterItem>('later')
export const userCollection = local<User>('users')
export const messageCollection = local<WebviewMessage & { id: string; channel: string }>('messages')
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

export function applyCache(snapshot: CachedConversation, replaceFrom?: string) {
  const { messages, ...state } = snapshot
  reconcile(cacheCollection, [{ ...state, id: snapshot.channel }], false)
  const rows = messages.map((message) => ({ ...message, id: `${snapshot.channel}:${message.ts}`, channel: snapshot.channel }))
  if (replaceFrom) {
    const ids = new Set(rows.map((row) => row.id))
    for (const row of messageCollection.values()) {
      // Channel history only includes top-level messages, so it cannot replace thread replies.
      if (row.thread_ts && row.thread_ts !== row.ts && row.subtype !== 'thread_broadcast') continue
      if (row.channel === snapshot.channel && row.ts >= replaceFrom && !ids.has(row.id)) messageCollection.delete(row.id)
    }
  }
  reconcile(messageCollection, rows, false)
}
