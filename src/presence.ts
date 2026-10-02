import { useEffect } from 'react'
import { eq, useLiveQuery } from '@tanstack/react-db'
import { localApi } from './api'
import { presenceCollection, reconcile } from './collections'

export function usePresenceActivity(user?: string) {
  useEffect(() => {
    if (!user) return
    let lastActivity = 0
    let disposed = false
    const unsubscribe = window.slackDesktop.onSelfPresence((presence) => {
      reconcile(presenceCollection, [{ id: user, presence }], false)
    })
    const report = async (event?: Event) => {
      if ((event && !event.isTrusted) || !document.hasFocus() || document.visibilityState === 'hidden' || Date.now() - lastActivity < 30_000) return
      lastActivity = Date.now()
      try {
        const result = await window.slackDesktop.reportActivity()
        if (result && !disposed) reconcile(presenceCollection, [{ id: user, presence: result.presence }], false)
      } catch (error) { console.warn('Could not report Slack activity', error) }
    }
    void report()
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'focus'] as const
    for (const event of events) window.addEventListener(event, report, { passive: true })
    return () => {
      disposed = true
      unsubscribe()
      for (const event of events) window.removeEventListener(event, report)
    }
  }, [user])
}

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
