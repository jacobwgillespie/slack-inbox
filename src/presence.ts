import { useEffect } from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { localApi } from './api'
import { presenceCollection, reconcile } from './collections'

export function usePresence(user?: string) {
  const { data } = useLiveQuery({ query: (q) => q.from({ presence: presenceCollection })
    .where(({ presence }) => eq(presence.id, user ?? '')), queryKey: [user] })
  useEffect(() => {
    if (!user) return
    let disposed = false
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const result = await localApi.presence(user)
        if (!disposed) reconcile(presenceCollection, [{ id: user, presence: result.presence }], false)
      } catch (error) { console.warn('Could not refresh Slack presence', error) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 30_000)
    document.addEventListener('visibilitychange', refresh)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [user])
  return data[0]?.presence
}
