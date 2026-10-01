import { readCachedConversation } from './useCachedConversation'

const openings = new Map<string, Promise<void>>()

// Suspend only the first opening until local hydration (or the first collected
// page) is ready. Subsequent openings use the retained Activity and live query.
export function prepareConversation(channel: string): Promise<void> {
  const existing = openings.get(channel)
  if (existing) return existing
  const opening = (async () => {
    const snapshot = await readCachedConversation(channel)
    if (snapshot?.messages.length || snapshot?.collected) return
    const bridge = window.slackDesktop!
    await new Promise<void>((resolve) => {
      let reading = false
      const finish = () => { clearTimeout(timeout); unsubscribe(); resolve() }
      const unsubscribe = bridge.onCacheChange((changed) => {
        if (changed !== channel || reading) return
        reading = true
        void readCachedConversation(channel).then((snapshot) => {
          if (snapshot?.messages.length || snapshot?.collected || snapshot?.error) finish()
        }).catch(finish).finally(() => { reading = false })
      })
      const timeout = setTimeout(finish, 15000)
      void bridge.refreshConversation(channel).catch(finish)
    })
  })().catch(console.error)
  if (openings.size >= 8) openings.delete(openings.keys().next().value!)
  openings.set(channel, opening)
  return opening
}
