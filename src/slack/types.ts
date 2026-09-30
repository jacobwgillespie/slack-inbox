export type ConversationKind = 'channel' | 'private' | 'dm' | 'group'

export interface Conversation {
  id: string
  name: string
  kind: ConversationKind
  userId?: string
}

export interface SlackFile {
  id: string
  name?: string
  title?: string
  permalink?: string
}

export interface SlackAttachment {
  fallback?: string
  pretext?: string
  title?: string
  title_link?: string
  text?: string
}

export interface Reaction {
  name: string
  count: number
}

export interface Message {
  ts: string
  text: string
  user?: string
  username?: string
  subtype?: string
  thread_ts?: string
  reply_count?: number
  files?: SlackFile[]
  attachments?: SlackAttachment[]
  reactions?: Reaction[]
  bot_profile?: { name?: string; icons?: { image_48?: string } }
}

export interface User {
  id: string
  handle: string
  displayName: string
  avatar?: string
}

export interface Session {
  userId: string
  handle: string
  teamId: string
  url: string
}

export interface InboxItem {
  id: string
  conversation: Conversation
  messages: Message[]
}

export interface LaterItem extends InboxItem {
  ts: string
  savedAt: number
}

export type PreferenceSource = 'slack' | 'local'

export type CredentialMode = 'session' | 'user' | 'none'

export interface SyncError {
  code: string
  message: string
  needed?: string
}

export type RealtimeState = 'connecting' | 'connected' | 'disconnected' | 'unavailable'

export interface SyncStatus {
  mode: CredentialMode
  realtime: RealtimeState
  running: boolean
  done: number
  total: number
  lastCompletedAt?: number
  error?: SyncError
}

export interface InboxPayload {
  version: number
  session?: Session
  sync: SyncStatus
  items: InboxItem[]
  later: LaterItem[]
  muted: string[]
  preferenceSource: PreferenceSource
  users: Record<string, User>
}

export interface SavedItemReference {
  channel: string
  ts: string
}

export interface LegacyPreferences {
  later: SavedItemReference[]
  muted: string[]
}

export interface ThreadPayload {
  messages: Message[]
  users: Record<string, User>
}
