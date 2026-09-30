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
  conversation: Conversation
  messages: Message[]
}

export interface LaterItem extends InboxItem {
  savedAt: number
}
