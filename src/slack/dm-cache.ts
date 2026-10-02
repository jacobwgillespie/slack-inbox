import type { User } from './types'
import type { WebviewMessage } from './webview'

export interface CachedConversation {
  channel: string
  messages: WebviewMessage[]
  users?: Record<string, User>
  hasMore: boolean
  collected: boolean
  complete: boolean
  syncing: boolean
  updatedAt?: number
  oldest?: string
  newest?: string
  error?: string
}
