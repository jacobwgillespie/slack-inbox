import { eq, useLiveQuery } from '@tanstack/react-db'
import { channelCollection, dmCollection, inboxCollection, laterCollection, preferenceCollection, runtimeCollection, userCollection, type RuntimeData } from './collections'
import type { ConversationSummary, DirectMessage, InboxItem, LaterItem, User } from './slack/types'

export const runtime = () => runtimeCollection.get('slack')!
export function updateRuntime(patch: Partial<Omit<RuntimeData, 'id'>>) {
  runtimeCollection.update('slack', (draft) => { Object.assign(draft, patch) })
}

export function setPreference(id: string, patch: { done?: string; muted?: boolean }) {
  const previous = preferenceCollection.get(id)
  if (previous) preferenceCollection.update(id, (draft) => { Object.assign(draft, patch) })
  else preferenceCollection.insert({ id, muted: false, ...patch })
}

export const keyed = <T extends { id: string }>(rows: Iterable<T>): Record<string, T> => Object.fromEntries([...rows].map((row) => [row.id, row]))
export function preferenceMaps(rows: Iterable<{ id: string; done?: string; muted: boolean }>) {
  const done: Record<string, string> = {}
  const muted: Record<string, true> = {}
  for (const row of rows) {
    if (row.done !== undefined) done[row.id] = row.done
    if (row.muted) muted[row.id] = true
  }
  return { done, muted }
}

export interface SlackData extends RuntimeData {
  users: Record<string, User>
  items: Record<string, InboxItem>
  directMessages: Record<string, DirectMessage>
  channels: Record<string, ConversationSummary>
  later: Record<string, LaterItem>
  done: Record<string, string>
  muted: Record<string, true>
}

export function readData(): SlackData {
  return {
    ...runtime(),
    users: keyed(userCollection.values()),
    items: keyed(inboxCollection.values()),
    directMessages: keyed(dmCollection.values()),
    channels: keyed(channelCollection.values()),
    later: keyed(laterCollection.values()),
    ...preferenceMaps(preferenceCollection.values()),
  }
}

export function useRuntime() {
  const { data } = useLiveQuery(runtimeCollection)
  return data[0] ?? runtime()
}

export function useUsers() {
  const { data } = useLiveQuery(userCollection)
  return keyed(data)
}

export function useConversation(id: string) {
  const { data: dms } = useLiveQuery({ query: (q) => q.from({ dm: dmCollection }).where(({ dm }) => eq(dm.id, id)), queryKey: [id] })
  const { data: channels } = useLiveQuery({ query: (q) => q.from({ channel: channelCollection }).where(({ channel }) => eq(channel.id, id)), queryKey: [id] })
  return channels[0] ?? dms[0]
}

export function useSavedMessage(channel: string, ts: string) {
  const id = `${channel}:${ts}`
  const { data } = useLiveQuery({ query: (q) => q.from({ saved: laterCollection }).where(({ saved }) => eq(saved.id, id)), queryKey: [id] })
  return data.length > 0
}
