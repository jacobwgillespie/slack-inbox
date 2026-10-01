import { compareTs, maxTs } from '../src/slack/timestamps.ts'
import type { HistoryPayload, Message } from '../src/slack/types.ts'
import type { Database } from './database.ts'
import { SlackError, type SlackClient } from './slack-client.ts'
import { toMessage } from './slack-data.ts'

const PAGE_SIZE = 100

interface HistoryResponse {
  messages: Message[]
  has_more?: boolean
  response_metadata?: { next_cursor?: string }
}

export class History {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly opened = new Set<string>()
  private readonly liveChannels = new Set<string>()
  private connectionVersion = 0

  constructor(private readonly database: Database, private readonly client: Pick<SlackClient, 'call'>) {}

  invalidateLive() {
    this.connectionVersion++
    this.liveChannels.clear()
    for (const channel of this.opened) this.database.setMetadata(`history_checked_at:${channel}`, 0)
  }

  observeMessage(channel: string, ts: string) {
    if (this.liveChannels.has(channel)) this.database.extendHistoryRange(channel, ts)
  }

  async page(channel: string, options: { before?: string; after?: string; cached?: boolean; maxAge: number; live?: boolean }): Promise<Omit<HistoryPayload, 'users'>> {
    const { before, after, cached, maxAge, live } = options
    const connectionVersion = this.connectionVersion
    const dm = this.database.directMessages(channel)[0]
    if (!dm) throw new SlackError('conversations.history', 'channel_not_found')
    this.opened.add(channel)
    let range = this.database.historyRange(channel, before)
    if (!cached) {
      if (!before) {
        const checkedAt = this.database.getMetadata<number>(`history_checked_at:${channel}`) ?? 0
        if (!range || Date.now() - checkedAt > maxAge || compareTs(dm.latestTs, range.newest) > 0) {
          await this.fetch(channel)
        }
      } else {
        const messages = range ? this.database.historyMessages(channel, range.oldest, before) : []
        if (!range || (messages.length < PAGE_SIZE && range.oldest !== '0')) {
          await this.fetch(channel, range?.oldest ?? before)
        }
      }
      range = this.database.historyRange(channel, before)
      if (!before && live && connectionVersion === this.connectionVersion && range) {
        this.liveChannels.add(channel)
        const newest = this.database.historyMessages(channel, range.oldest, undefined, 1)[0]?.ts
        if (newest) this.database.extendHistoryRange(channel, newest)
        range = this.database.historyRange(channel)
      }
    }
    if (!range) return { messages: [], hasMore: true }
    // A live refresh rereads the already visible window, including edits and deletions.
    const floor = maxTs(after, range.oldest)
    const rows = this.database.historyMessages(channel, floor, before, after ? -1 : PAGE_SIZE + 1, range.newest)
    const messages = (after ? rows : rows.slice(0, PAGE_SIZE)).reverse()
    const hasMore = range.oldest !== '0' || (!after && rows.length > PAGE_SIZE) ||
      Boolean(after && this.database.historyMessages(channel, range.oldest, floor, 1).length)
    return { messages, hasMore, before: messages[0]?.ts }
  }

  private fetch(channel: string, before?: string): Promise<void> {
    const key = `${channel}:${before ?? 'latest'}`
    const existing = this.pending.get(key)
    if (existing) return existing
    const request = this.fetchPage(channel, before).finally(() => this.pending.delete(key))
    this.pending.set(key, request)
    return request
  }

  private async fetchPage(channel: string, before?: string) {
    const now = Date.now()
    const newest = before ?? `${Math.floor(now / 1000)}.${String((now % 1000) * 1000).padStart(6, '0')}`
    let cursor: string | undefined
    let result: HistoryResponse
    do {
      result = await this.client.call<HistoryResponse>('conversations.history', {
        channel, latest: newest, inclusive: false, limit: PAGE_SIZE, cursor,
      })
      cursor = result.response_metadata?.next_cursor || undefined
    } while (!result.messages.length && cursor)
    const messages = result.messages.map(toMessage).sort((a, b) => compareTs(a.ts, b.ts))
    const hasMore = Boolean(result.has_more || cursor)
    if (hasMore && !messages.length) throw new SlackError('conversations.history', 'empty_history_page')
    this.database.cacheHistoryPage(channel, messages, { oldest: hasMore ? messages[0]!.ts : '0', newest })
    if (!before) this.database.setMetadata(`history_checked_at:${channel}`, Date.now())
  }
}
