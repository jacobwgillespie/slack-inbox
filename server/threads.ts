import type { Message } from '../src/slack/types.ts'
import type { Database, ThreadRecord } from './database.ts'
import type { RealtimeEvent } from './realtime.ts'
import type { SlackClient } from './slack-client.ts'
import { toMessage } from './slack-data.ts'

const PAGE_SIZE = 10
const MAX_PAGES = 5

interface RawThread {
  root_msg: Message & { channel: string; last_read?: string; latest_reply?: string }
  unread_replies?: Message[]
  latest_replies?: Message[]
}

interface ThreadView {
  threads?: RawThread[]
  has_more?: boolean
  total_unread_replies?: number
}

interface RawSubscription {
  channel?: string
  thread_ts?: string
  last_read?: string
  active?: boolean
}

function subscriptionFrom(event: RealtimeEvent): RawSubscription {
  const subscription = event.subscription
  return subscription && typeof subscription === 'object' ? (subscription as RawSubscription) : (event as RawSubscription)
}

export class Threads {
  constructor(
    private readonly database: Database,
    private readonly client: SlackClient,
    private readonly changed: () => void,
    private readonly requestSync: () => void,
  ) {}

  async sync() {
    const threads: RawThread[] = []
    let currentTs: string | undefined
    let unreadSeen = 0
    let complete = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const view = await this.client.call<ThreadView>('subscriptions.thread.getView', {
        limit: PAGE_SIZE,
        current_ts: currentTs,
      })
      const pageThreads = view.threads ?? []
      threads.push(...pageThreads)
      unreadSeen += pageThreads.reduce((total, thread) => total + (thread.unread_replies?.length ?? 0), 0)
      const last = pageThreads[pageThreads.length - 1]?.root_msg
      if (!view.has_more || !last || unreadSeen >= (view.total_unread_replies ?? 0)) {
        complete = true
        break
      }
      currentTs = last.latest_reply ?? last.ts
    }

    const records: ThreadRecord[] = []
    const messages: [string, Message][] = []
    for (const { root_msg: root, unread_replies: unread = [], latest_replies: latest = [] } of threads) {
      records.push({ channel: root.channel, threadTs: root.ts, lastRead: root.last_read ?? root.ts })
      for (const message of [root, ...unread, ...latest]) messages.push([root.channel, toMessage(message)])
    }
    this.database.applyThreadView(records, messages, complete)
    this.changed()
  }

  async markRead(channel: string, threadTs: string, ts: string) {
    await this.client.call('subscriptions.thread.mark', { channel, thread_ts: threadTs, ts })
    this.database.setThreadLastRead(channel, threadTs, ts)
    this.changed()
  }

  handleEvent(event: RealtimeEvent): boolean {
    const subscription = subscriptionFrom(event)
    const { channel, thread_ts: threadTs, last_read: lastRead } = subscription
    switch (event.type) {
      case 'thread_marked':
        if (channel && threadTs && lastRead) this.database.setThreadLastRead(channel, threadTs, lastRead)
        break
      case 'thread_subscribed':
        if (channel && threadTs) {
          this.database.setThread({ channel, threadTs, lastRead: lastRead ?? threadTs })
          this.requestSync()
        }
        break
      case 'thread_unsubscribed':
        if (channel && threadTs) this.database.deleteThread(channel, threadTs)
        break
      default:
        return false
    }
    this.changed()
    return true
  }
}
