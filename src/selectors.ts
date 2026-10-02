import { messageCollection } from './collections'
import { compareTs } from './slack/timestamps'
import type { InboxItem, LaterItem, Message, Session } from './slack/types'
import { isConversationView, VIEWS, type InboxState, type View } from './store'
import type { SlackData } from './data'

export type VisibleSource = Pick<SlackData, 'items' | 'directMessages' | 'channels' | 'done' | 'later' | 'muted' | 'session'> & { view: View }

export const latestTs = (item: InboxItem) => item.messages[item.messages.length - 1]?.ts ?? '0'

export function mentionsSelf(item: InboxItem, session?: Session): boolean {
  if (!session) return false
  return item.messages.some((message) => message.text.includes(`<@${session.userId}`))
}

function matchesImportantRules(item: InboxItem, message: Message, session?: Session): boolean {
  if (item.conversation.kind === 'dm' || item.conversation.kind === 'group') return true
  return Boolean(session && message.text.includes(`<@${session.userId}`))
}

export function isMessageImportant(item: InboxItem, message: Message, session?: Session): boolean {
  if (message.classification) return message.classification.label === 'important'
  return matchesImportantRules(item, message, session)
}

export function isImportant(item: InboxItem, session?: Session): boolean {
  if (item.thread) return true
  return item.messages.some((message) => isMessageImportant(item, message, session))
}

export function threadTargetFor(item: InboxItem, threadTarget?: string): string | undefined {
  return threadTarget ?? item.thread?.ts
}

export function findMessage(item: InboxItem, ts: string): Message | undefined {
  return item.thread?.root.ts === ts ? item.thread.root :
    item.messages.find((message) => message.ts === ts) ?? messageCollection.get(`${item.conversation.id}:${ts}`)
}

const isMutedChannelItem = (item: InboxItem, muted: Record<string, true>) =>
  !item.thread && Boolean(muted[item.conversation.id])

const byLatest = (a: InboxItem, b: InboxItem) => compareTs(latestTs(b), latestTs(a))
const bySavedAt = (a: LaterItem, b: LaterItem) => b.savedAt - a.savedAt

export function computeVisible(state: VisibleSource): InboxItem[] {
  const summaries = { ...state.directMessages, ...state.channels }
  const archived = (item: InboxItem) => {
    const through = state.done[item.conversation.id]
    return through !== undefined && compareTs(summaries[item.conversation.id]?.latestTs ?? latestTs(item), through) <= 0
  }
  const inbox = Object.values(state.items).filter((item) => !archived(item))
  switch (state.view) {
    case 'done':
      return Object.values(summaries).filter((item) => archived(item) && !state.later[`${item.id}:${state.done[item.id]}`]).sort((a, b) => compareTs(b.latestTs, a.latestTs) || a.conversation.name.localeCompare(b.conversation.name))
    case 'inbox':
      return Object.values(summaries).filter((item) => !archived(item)).sort((a, b) =>
        compareTs(b.latestTs, a.latestTs) || a.conversation.name.localeCompare(b.conversation.name),
      )
    case 'later':
      return Object.values(state.later).sort(bySavedAt)
    case 'muted':
      return inbox.filter((item) => isMutedChannelItem(item, state.muted)).sort(byLatest)
    case 'important':
    case 'other': {
      const important = state.view === 'important'
      return inbox
        .filter((item) => !isMutedChannelItem(item, state.muted) && isImportant(item, state.session) === important)
        .sort(byLatest)
    }
  }
}

export function computeCounts(state: VisibleSource): Record<View, number> {
  return Object.fromEntries(VIEWS.map((view) => [view, computeVisible({ ...state, view }).length])) as Record<
    View,
    number
  >
}

export function currentItem(state: VisibleSource & Pick<InboxState, 'selectedId'>): InboxItem | undefined {
  if (!state.selectedId) return undefined
  if (isConversationView(state.view)) return state.channels[state.selectedId] ?? state.directMessages[state.selectedId]
  return state.view === 'later' ? state.later[state.selectedId] : state.items[state.selectedId]
}

