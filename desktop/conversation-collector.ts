import type { WebContents } from 'electron'
import type { Database } from '../server/database.ts'
import type { SyncEngine } from '../server/sync.ts'
import { compareTs } from '../src/slack/timestamps.ts'
import type { WebviewConversation } from '../src/slack/webview.ts'
import { readConversation, scrollConversation } from './conversation.ts'

interface Job { channel: string; older: boolean; priority: number; before?: string; until?: string }

export class ConversationCollector {
  private queue = new Map<string, Job>()
  private running = false
  private stopped = false
  private visible = new Set<string>()
  private latest = new Map<string, string>()
  private listeners = new Set<() => void>()
  private unsubscribe: () => void
  private active?: Job

  constructor(private contents: WebContents, private database: Database, private engine: SyncEngine,
    private changed: (channel: string) => void) {
    for (const conversation of database.conversationSummaries()) this.latest.set(conversation.id, conversation.latestTs)
    this.unsubscribe = engine.subscribe(() => {
      for (const conversation of database.conversationSummaries()) {
        const previous = this.latest.get(conversation.id)
        this.latest.set(conversation.id, conversation.latestTs)
        if (previous !== undefined && conversation.latestTs !== '0' && conversation.latestTs !== previous && compareTs(conversation.latestTs, conversation.lastRead ?? '0') > 0) this.enqueue(conversation.id, false, 0)
      }
    })
  }

  watch(channels: string[], selected?: string) {
    this.visible = new Set(channels)
    for (const [key, job] of this.queue) if (job.priority > 0 && !job.until && !this.visible.has(job.channel)) this.queue.delete(key)
    for (const channel of channels) {
      const cache = this.database.cachedConversation(channel)
      if (!cache.collected || Date.now() - (cache.updatedAt ?? 0) > 60000) this.enqueue(channel, false, channel === selected ? 0 : 1)
    }
    if (selected) this.refresh(selected)
  }

  refresh(channel: string, older = false) {
    this.enqueue(channel, older, 0)
  }

  isSyncing(channel: string) { return this.active?.channel === channel || [...this.queue.values()].some((job) => job.channel === channel) }

  notify(channel: string) {
    if (this.active?.channel === channel) for (const listener of this.listeners) listener()
  }

  stop() {
    this.stopped = true
    this.unsubscribe()
    for (const listener of this.listeners) listener()
    this.queue.clear()
  }

  private enqueue(channel: string, older: boolean, priority: number) {
    if (this.stopped || !this.database.hasConversation(channel)) return
    const key = `${channel}:${older}`
    if (this.active?.channel === channel && this.active.older === older) return
    const existing = this.queue.get(key)
    if (!existing || existing.priority > priority) this.queue.set(key, { channel, older, priority })
    void this.pump()
  }

  private async navigate(channel: string, before?: string) {
    const team = this.database.getMetadata<{ teamId: string }>('session')?.teamId
    if (!team) throw new Error('Slack is not signed in.')
    const destination = `https://app.slack.com/client/${team}/${channel}`
    if (this.contents.getURL().split('/')[5]?.split('?')[0] === channel) {
      if (!before) return
      const current = await readConversation(this.contents)
      if (!current.hasMore || (current.messages[0] && compareTs(current.messages[0].ts, before) <= 0)) return
    }
    if (before) {
      await this.contents.loadURL(`${destination}?message_ts=${before}&cid=${channel}`)
      return
    }
    const clicked = this.contents.getURL().startsWith('https://app.slack.com/client/') && await this.contents.executeJavaScript(`(() => {
      const destination = ${JSON.stringify(destination)};
      const link = [...document.querySelectorAll('.p-channel_sidebar a[href]')].find(link => link.href.split('?')[0] === destination);
      if (!link) return false;
      link.click(); return true;
    })()`)
    if (!clicked) await this.contents.loadURL(destination)
  }

  private waitForSnapshot(channel: string, before?: string, newest?: string): Promise<WebviewConversation> {
    return new Promise((resolve, reject) => {
      let busy = false, dirty = false, finished = false
      let latest: WebviewConversation | undefined
      const finish = (error?: unknown) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        this.listeners.delete(read)
        if (error) reject(error)
        else if (latest) resolve(latest)
        else reject(new Error('Slack did not render the conversation.'))
      }
      const read = async () => {
        if (finished) return
        if (this.stopped) { finish(new Error('Collector stopped.')); return }
        if (busy) { dirty = true; return }
        busy = true
        try {
          await this.contents.executeJavaScript(`(() => {
            if (document.querySelector('.p-message_pane')?.clientHeight) return;
            const tab = [...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent.trim() === 'Messages');
            if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
          })()`)
          const snapshot = await readConversation(this.contents)
          if (snapshot.channel === channel && snapshot.ready) {
            latest = snapshot
            const reachedOlder = !before || !snapshot.hasMore || (snapshot.messages[0] && compareTs(snapshot.messages[0].ts, before) < 0)
            const reachedLatest = !newest || (snapshot.messages.at(-1) && compareTs(snapshot.messages.at(-1)!.ts, newest) >= 0)
            if (reachedOlder && reachedLatest) finish()
          }
        } catch (error) { if (this.contents.getURL().split('/')[5]?.split('?')[0] === channel) finish(error) }
        finally { busy = false; if (dirty && !finished) { dirty = false; void read() } }
      }
      const timeout = setTimeout(() => finish(), before ? 1500 : 15000)
      this.listeners.add(read)
      void read()
    })
  }

  private async pump() {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (this.queue.size && !this.stopped) {
        const [key, job] = [...this.queue.entries()].sort((a, b) => a[1].priority - b[1].priority)[0]!
        this.queue.delete(key)
        this.active = job
        this.changed(job.channel)
        try {
          const cached = this.database.cachedConversation(job.channel)
          await this.navigate(job.channel, job.before ?? (job.older ? cached.oldest : undefined))
          let snapshot = await this.waitForSnapshot(job.channel)
          if (!job.older) {
            await scrollConversation(this.contents, 'latest')
            snapshot = await this.waitForSnapshot(job.channel, undefined, this.latest.get(job.channel))
          }
          if (this.database.cacheWebview(snapshot)) this.engine.webviewChanged()
          await this.reconcile(snapshot, !job.older ? cached.newest : undefined)
          this.changed(job.channel)
          // Read contiguous overlapping windows; yield to other jobs after four.
          const overlap = job.until ?? (!job.older ? cached.newest : undefined)
          let pages = 0
          let stalled = 0
          while (snapshot.hasMore && pages < 4 && !this.stopped &&
            (!overlap || compareTs(snapshot.messages[0]?.ts ?? '0', overlap) > 0)) {
            if ([...this.queue.values()].some((next) => next.priority < job.priority)) break
            const before = snapshot.messages[0]?.ts
            await scrollConversation(this.contents, 'older')
            snapshot = await this.waitForSnapshot(job.channel, before)
            if (this.database.cacheWebview(snapshot)) this.engine.webviewChanged()
            await this.reconcile(snapshot)
            this.changed(job.channel)
            pages++
            stalled = before === snapshot.messages[0]?.ts ? stalled + 1 : 0
            if (stalled >= 2) break
          }
          const gap = overlap && snapshot.messages[0] && compareTs(snapshot.messages[0].ts, overlap) > 0
          if (snapshot.hasMore && stalled < 2 && gap) {
            this.queue.set(`${job.channel}:gap`, { channel: job.channel, older: true, priority: 1, before: snapshot.messages[0]!.ts, until: overlap })
          } else if (snapshot.hasMore && stalled < 2 && !cached.complete && this.visible.has(job.channel)) {
            this.queue.set(`${job.channel}:true`, { channel: job.channel, older: true, priority: 2 })
          }
        } catch (error) {
          if (!this.stopped) this.database.webviewFailure(job.channel, error instanceof Error ? error.message : String(error))
        } finally { this.active = undefined; if (!this.stopped) this.changed(job.channel) }
      }
    } finally { this.running = false }
  }

  private async reconcile(snapshot: WebviewConversation, previousNewest?: string) {
    const oldest = snapshot.hasMore ? snapshot.messages[0]?.ts : '0'
    const renderedNewest = snapshot.messages.at(-1)?.ts
    const newest = previousNewest && compareTs(previousNewest, renderedNewest ?? '0') > 0 ? previousNewest : renderedNewest
    if (!snapshot.ready || !oldest || !newest) return
    try {
      await this.engine.reconcileHistory(snapshot.channel, oldest, newest)
    } catch (error) {
      console.warn('Could not reconcile Slack history', error)
    }
  }
}
