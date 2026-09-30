import type { LegacyPreferences } from './slack/types'

const STORE_KEY = 'slack-inbox'
const PENDING_KEY = 'slack-inbox-legacy-preferences'

interface LegacyLaterEntry {
  conversation?: { id?: string }
  messages?: { ts?: string }[]
}

interface LegacyState {
  later?: Record<string, LegacyLaterEntry>
  muted?: Record<string, true>
}

function readLegacyState(): LegacyPreferences | undefined {
  const raw = localStorage.getItem(STORE_KEY)
  if (!raw) return undefined
  const state = (JSON.parse(raw) as { state?: LegacyState }).state ?? {}
  const later = Object.values(state.later ?? {}).flatMap((entry) => {
    const channel = entry.conversation?.id
    const ts = entry.messages?.at(-1)?.ts
    return channel && ts ? [{ channel, ts }] : []
  })
  const muted = Object.keys(state.muted ?? {})
  return later.length || muted.length ? { later, muted } : undefined
}

export function captureLegacyPreferences(): LegacyPreferences | undefined {
  try {
    const pending = localStorage.getItem(PENDING_KEY)
    if (pending) return JSON.parse(pending) as LegacyPreferences
    const legacy = readLegacyState()
    if (legacy) localStorage.setItem(PENDING_KEY, JSON.stringify(legacy))
    return legacy
  } catch {
    return undefined
  }
}

export function clearLegacyPreferences() {
  try {
    localStorage.removeItem(PENDING_KEY)
  } catch {
    return
  }
}
