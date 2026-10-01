import type { Message } from './types'

export interface WebviewMessage extends Message {
  images?: { src: string; alt: string; width?: number; height?: number }[]
}

export interface WebviewConversation {
  channel: string
  messages: WebviewMessage[]
  hasMore: boolean
  ready: boolean
}
