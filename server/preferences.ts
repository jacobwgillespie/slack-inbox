import type { LegacyPreferences, Message, PreferenceSource, SavedItemReference } from '../src/slack/types.ts'
import type { Database, SavedItemRecord } from './database.ts'
import { SlackError, type SlackClient } from './slack-client.ts'
import { toConversation, toMessage, type RawConversation } from './slack-data.ts'

const SAVED_PAGE_SIZE = 50

interface RawSavedItem {
  item_id: string
  item_type: string
  ts?: string
  state: string
  date_created: number
}

interface ChannelNotificationPreferences {
  muted?: boolean
}

interface NotificationPreferences {
  channels?: Record<string, ChannelNotificationPreferences>
}

function parseNotificationPreferences(value: unknown): NotificationPreferences {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as NotificationPreferences
    } catch {
      return {}
    }
  }
  return (value as NotificationPreferences | undefined) ?? {}
}

function mutedChannels(preferences: NotificationPreferences): Set<string> {
  const entries = Object.entries(preferences.channels ?? {})
  return new Set(entries.filter(([, channel]) => channel.muted).map(([id]) => id))
}

export class Preferences {
  readonly source: PreferenceSource
  private readonly pendingMessages = new Set<string>()

  constructor(
    private readonly database: Database,
    private readonly client: SlackClient,
    usesSlack: boolean,
    private readonly changed: () => void,
  ) {
    this.source = usesSlack ? 'slack' : 'local'
  }

  async sync() {
    if (this.source === 'local') return
    await Promise.all([this.syncSavedItems(), this.syncMuted()])
  }

  applyNotificationPreferences(value: unknown) {
    this.database.replaceMuted(mutedChannels(parseNotificationPreferences(value)))
    this.changed()
  }

  later() {
    const { items, missing } = this.database.later()
    for (const reference of missing) this.fetchSavedMessage(reference)
    return items
  }

  async save(channel: string, ts: string): Promise<{ created: boolean }> {
    const existing = this.database.savedItem(channel, ts)
    if (existing?.state === 'in_progress') return { created: false }
    if (this.source === 'slack') {
      if (existing) await this.updateSavedItem(channel, ts, 'uncompleted')
      else await this.addSavedItem(channel, ts)
    }
    this.database.setSavedItem({
      channel,
      ts,
      state: 'in_progress',
      dateCreated: existing?.dateCreated ?? Math.floor(Date.now() / 1000),
    })
    this.changed()
    return { created: !existing }
  }

  async complete(channel: string, ts: string) {
    await this.setSavedState(channel, ts, 'completed')
  }

  async reopen(channel: string, ts: string) {
    await this.setSavedState(channel, ts, 'in_progress')
  }

  async remove(channel: string, ts: string) {
    if (this.source === 'slack') {
      await this.client.call('saved.delete', { item_type: 'message', item_id: channel, ts })
    }
    this.database.deleteSavedItem(channel, ts)
    this.changed()
  }

  async setMuted(channel: string, muted: boolean) {
    if (this.source === 'slack') {
      const result = await this.client.call<{ all_notifications_prefs?: unknown }>('users.prefs.setNotifications', {
        name: 'muted',
        value: String(muted),
        global: false,
        channel_id: channel,
      })
      if (result.all_notifications_prefs) {
        this.applyNotificationPreferences(result.all_notifications_prefs)
        return
      }
    }
    this.database.setMuted(channel, muted)
    this.changed()
  }

  async importLegacy(preferences: LegacyPreferences) {
    for (const { channel, ts } of preferences.later) await this.save(channel, ts)
    for (const channel of preferences.muted) await this.setMuted(channel, true)
  }

  private async setSavedState(channel: string, ts: string, state: SavedItemRecord['state']) {
    const existing = this.database.savedItem(channel, ts)
    if (this.source === 'slack') {
      await this.updateSavedItem(channel, ts, state === 'completed' ? 'completed' : 'uncompleted')
    }
    this.database.setSavedItem({
      channel,
      ts,
      state,
      dateCreated: existing?.dateCreated ?? Math.floor(Date.now() / 1000),
    })
    this.changed()
  }

  private async addSavedItem(channel: string, ts: string) {
    try {
      await this.client.call('saved.add', { item_type: 'message', item_id: channel, ts })
    } catch (error) {
      if (!(error instanceof SlackError)) throw error
      await this.updateSavedItem(channel, ts, 'uncompleted')
    }
  }

  private async updateSavedItem(channel: string, ts: string, mark: 'completed' | 'uncompleted') {
    await this.client.call('saved.update', { item_type: 'message', item_id: channel, ts, mark })
  }

  private async syncSavedItems() {
    const startedAt = Math.floor(Date.now() / 1000)
    const items = await this.client.paginate<RawSavedItem>('saved.list', 'saved_items', { limit: SAVED_PAGE_SIZE })
    this.database.replaceInProgressSavedItems(
      items
        .filter((item) => item.item_type === 'message' && item.ts && item.state === 'in_progress')
        .map((item) => ({
          channel: item.item_id,
          ts: item.ts ?? '',
          state: 'in_progress' as const,
          dateCreated: item.date_created,
        })),
      startedAt,
    )
    this.changed()
  }

  private async syncMuted() {
    const result = await this.client.call<{ prefs?: { all_notifications_prefs?: unknown } }>('users.prefs.get')
    this.applyNotificationPreferences(result.prefs?.all_notifications_prefs)
  }

  private fetchSavedMessage({ channel, ts }: SavedItemReference) {
    const key = `${channel}:${ts}`
    if (this.pendingMessages.has(key)) return
    this.pendingMessages.add(key)
    void this.loadSavedMessage(channel, ts)
      .then(() => this.changed())
      .catch((error) => console.warn(`Could not load saved message ${key}`, error))
  }

  private async loadSavedMessage(channel: string, ts: string) {
    if (!this.database.hasAnyConversation(channel)) {
      const info = await this.client.call<{ channel: RawConversation & { is_member?: boolean } }>('conversations.info', {
        channel,
      })
      this.database.upsertConversation(toConversation(info.channel), Boolean(info.channel.is_member))
    }
    if (this.database.message(channel, ts)) return

    const history = await this.client.call<{ messages: Message[] }>('conversations.history', {
      channel,
      latest: ts,
      oldest: ts,
      inclusive: true,
      limit: 1,
    })
    const found = history.messages.find((message) => message.ts === ts)
    if (found) {
      this.database.upsertMessages(channel, [toMessage(found)])
      return
    }
    const replies = await this.client.call<{ messages: Message[] }>('conversations.replies', {
      channel,
      ts,
      latest: ts,
      oldest: ts,
      inclusive: true,
      limit: 1,
    })
    const reply = replies.messages.find((message) => message.ts === ts)
    if (reply) this.database.upsertMessages(channel, [toMessage(reply)])
  }
}
