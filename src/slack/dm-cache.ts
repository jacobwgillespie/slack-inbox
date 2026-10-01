import type { WebviewMessage } from './webview'

export interface CachedConversation {
  channel: string
  messages: WebviewMessage[]
  hasMore: boolean
  collected: boolean
  complete: boolean
  syncing: boolean
  updatedAt?: number
  oldest?: string
  newest?: string
  error?: string
}
