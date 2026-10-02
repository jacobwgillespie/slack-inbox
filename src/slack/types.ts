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
  mimetype?: string
  url_private?: string
  thumb_720?: string
  original_w?: number
  original_h?: number
}

export interface SlackAttachment {
  image_url?: string
  fallback?: string
  pretext?: string
  title?: string
  title_link?: string
  text?: string
}

export interface Reaction {
  name: string
  count: number
  users?: string[]
  mine?: boolean
}

export type ClassificationLabel = 'important' | 'other'

export interface Classification {
  label: ClassificationLabel
  reason: string
  source: 'model' | 'user'
}

export interface Message {
  ts: string
  classification?: Classification
  text: string
  user?: string
  username?: string
  subtype?: string
  thread_ts?: string
  reply_count?: number
  files?: SlackFile[]
  blocks?: { type: string; image_url?: string; alt_text?: string }[]
  attachments?: SlackAttachment[]
  reactions?: Reaction[]
  emoji?: Record<string, string>
  bot_profile?: { name?: string; icons?: { image_48?: string } }
}

export interface User {
  id: string
  handle: string
  displayName: string
  firstName?: string
  avatar?: string
  lastActivityTs?: string
}

export interface Session {
  userId: string
  handle: string
  teamId: string
  url: string
}

export interface ThreadContext {
  ts: string
  root: Message
}

export interface InboxItem {
  id: string
  conversation: Conversation
  messages: Message[]
  thread?: ThreadContext
}

export interface ConversationSummary extends InboxItem {
  lastRead?: string
  latestTs: string
}

export type DirectMessage = ConversationSummary

export interface LaterItem extends InboxItem {
  ts: string
  savedAt: number
}

export interface SyncError {
  code: string
  message: string
  needed?: string
}

export type RealtimeState = 'connecting' | 'connected' | 'disconnected' | 'unavailable'

export interface SyncStatus {
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
  directMessages: DirectMessage[]
  channels: ConversationSummary[]
  done: Record<string, string>
  later: LaterItem[]
  muted: string[]
  inboxMuted: string[]
  users: Record<string, User>
}

export interface SavedItemReference {
  channel: string
  ts: string
}

export interface ClassificationEntry extends SavedItemReference {
  classification: Classification | null
}

export interface LegacyPreferences {
  later: SavedItemReference[]
  muted: string[]
}

export interface ThreadPayload {
  root?: Message
  messages: Message[]
  users: Record<string, User>
}

export interface TypingEvent {
  channel: string
  user: string
  active: boolean
}

export interface RealtimeEvent {
  type: string
  [key: string]: unknown
}
