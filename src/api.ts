import type {
  ClassificationEntry,
  ClassificationLabel,
  InboxPayload,
  HistoryPayload,
  LegacyPreferences,
  SavedItemReference,
  SyncError,
  ThreadPayload,
  TypingEvent,
  Reaction,
} from './slack/types'

export class LocalApiError extends Error {
  readonly code: string
  readonly needed?: string

  constructor(error: SyncError) {
    super(error.message)
    this.code = error.code
    this.needed = error.needed
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new LocalApiError(body?.error ?? { code: `http_${response.status}`, message: response.statusText })
  }
  return body as T
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const localApi = {
  inbox: () => request<InboxPayload>('/local/inbox'),
  emoji: () => request<Record<string, string>>('/local/emoji'),
  sync: () => post('/local/sync'),
  markRead: (channel: string, ts: string) => post('/local/mark', { channel, ts }),
  setDone: (channel: string, ts?: string, markRead = true) => post('/local/done', { channel, ts: ts ?? null, markRead }),
  markThreadRead: (channel: string, threadTs: string, ts: string) =>
    post('/local/thread/mark', { channel, threadTs, ts }),
  postMessage: (channel: string, text: string, threadTs?: string) => post('/local/post', { channel, text, threadTs }),
  saveForLater: (channel: string, ts: string) => post<{ created: boolean }>('/local/later', { channel, ts }),
  addReaction: (channel: string, ts: string, name: string) => post<{ reactions: Reaction[] }>('/local/reaction', { channel, ts, name }),
  removeReaction: (channel: string, ts: string, name: string) => post<{ reactions: Reaction[] }>('/local/reaction/remove', { channel, ts, name }),
  completeLater: (channel: string, ts: string) => post('/local/later/complete', { channel, ts }),
  reopenLater: (channel: string, ts: string) => post('/local/later/reopen', { channel, ts }),
  removeLater: (channel: string, ts: string) => post('/local/later/remove', { channel, ts }),
  setMuted: (channel: string, muted: boolean) => post('/local/mute', { channel, muted }),
  importLegacyPreferences: (preferences: LegacyPreferences) => post('/local/import', preferences),
  setClassification: (messages: SavedItemReference[], label: ClassificationLabel) =>
    post('/local/classifications', { messages, label }),
  restoreClassifications: (entries: ClassificationEntry[]) => post('/local/classifications/restore', { entries }),
  threadReplies: (channel: string, ts: string) =>
    request<ThreadPayload>(`/local/replies?${new URLSearchParams({ channel, ts })}`),
  history: (channel: string, options: { before?: string; after?: string; cached?: boolean } = {}) => {
    const params = new URLSearchParams({ channel })
    if (options.before) params.set('before', options.before)
    if (options.after) params.set('after', options.after)
    if (options.cached) params.set('cached', 'true')
    return request<HistoryPayload>(`/local/history?${params}`)
  },
}

export function subscribeToChanges(onChange: (version: number) => void, onTyping: (event: TypingEvent) => void, onDisconnect: () => void): () => void {
  const events = new EventSource('/local/events')
  events.addEventListener('typing', (event) => onTyping(JSON.parse((event as MessageEvent).data) as TypingEvent))
  events.onerror = onDisconnect
  events.onmessage = (event) => onChange((JSON.parse(event.data) as { version: number }).version)
  return () => events.close()
}
