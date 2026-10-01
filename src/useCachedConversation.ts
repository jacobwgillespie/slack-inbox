import { loadImagePreview } from './imagePreview'
import { useEffect, useState } from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { applyCache, cacheCollection, messageCollection } from './collections'

const windows = new Map<string, string>()
const activeChannels = new Set<string>()
const requestedOlder = new Map<string, string | undefined>()

export async function readCachedConversation(channel: string, before?: string) {
  const bridge = window.slackDesktop
  const after = before ? undefined : windows.get(channel)
  const [snapshot] = await bridge.readCache(channel, { before, after })
  if (!snapshot) return
  applyCache(snapshot, after)
  const earliest = snapshot.messages[0]?.ts
  if (earliest && (!windows.get(channel) || earliest < windows.get(channel)!)) windows.set(channel, earliest)
  return snapshot
}

export function useCacheSync() {
  useEffect(() => {
    const bridge = window.slackDesktop
    let disposed = false
    const pending = new Set<string>()
    const dirty = new Set<string>()
    const read = async (channel: string) => {
      if (pending.has(channel)) { dirty.add(channel); return }
      pending.add(channel)
      try {
        do {
          dirty.delete(channel)
          if (requestedOlder.has(channel)) {
            const page = await readCachedConversation(channel, requestedOlder.get(channel))
            if (page?.messages.length || !page?.hasMore || page.error) requestedOlder.delete(channel)
          }
          await readCachedConversation(channel)
        } while (dirty.has(channel) && !disposed)
      } finally { pending.delete(channel) }
    }
    const unsubscribe = bridge.onCacheChange((channel) => {
      if (channel) void read(channel).then(() => {
        const recent = [...messageCollection.values()].filter((message) => message.channel === channel).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 10)
        for (const image of recent.flatMap((message) => message.images ?? []).slice(0, 6)) void loadImagePreview(image.src).catch(() => {})
      }).catch(console.error)
      else for (const id of activeChannels) void read(id).catch(console.error)
    })
    return () => { disposed = true; unsubscribe() }
  }, [])
}

export function useCachedConversation(channel: string, enabled: boolean) {
  const { data: messages } = useLiveQuery({ query: (q) => q.from({ message: messageCollection })
    .where(({ message }) => eq(message.channel, channel)).orderBy(({ message }) => message.ts, 'asc'), queryKey: [channel] })
  const { data: states } = useLiveQuery({ query: (q) => q.from({ state: cacheCollection }).where(({ state }) => eq(state.id, channel)), queryKey: [channel] })
  const state = states[0]
  const [readingOlder, setReadingOlder] = useState(false)
  useEffect(() => {
    if (!enabled) return
    activeChannels.add(channel)
    void readCachedConversation(channel).catch(console.error)
    return () => { activeChannels.delete(channel) }
  }, [channel, enabled])
  const scroll = async (direction: 'older' | 'latest') => {
    if (!enabled || readingOlder) return
    if (direction === 'latest') { await window.slackDesktop.refreshConversation(channel); return }
    setReadingOlder(true)
    try {
      const snapshot = await readCachedConversation(channel, messages[0]?.ts)
      if (!snapshot?.messages.length && snapshot?.hasMore) {
        requestedOlder.set(channel, messages[0]?.ts)
        await window.slackDesktop.refreshConversation(channel, true)
      }
    } finally { setReadingOlder(false) }
  }
  return { snapshot: state ? { ...state, messages, ready: true } : undefined, error: state?.error,
    loadingOlder: readingOlder || Boolean(state?.syncing && !messages.length), scroll: (direction: 'older' | 'latest') => void scroll(direction).catch(console.error) }
}
