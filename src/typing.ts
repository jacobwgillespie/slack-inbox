import { create } from 'zustand'
import type { TypingEvent } from './slack/types'
import { runtime } from './data'

const EMPTY: string[] = []
const useTypingState = create<{ channels: Record<string, string[]> }>(() => ({ channels: {} }))
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function useTyping(channel: string) {
  return useTypingState((state) => state.channels[channel] ?? EMPTY)
}

export function updateTyping(event: TypingEvent) {
  if (event.user === runtime().session?.userId) return
  const key = `${event.channel}:${event.user}`
  clearTimeout(timers.get(key))
  timers.delete(key)
  useTypingState.setState(({ channels }) => {
    const users = channels[event.channel] ?? EMPTY
    const next = event.active ? [...new Set([...users, event.user])] : users.filter((user) => user !== event.user)
    if (next.length) return { channels: { ...channels, [event.channel]: next } }
    const remaining = { ...channels }
    delete remaining[event.channel]
    return { channels: remaining }
  })
  if (event.active) timers.set(key, setTimeout(() => updateTyping({ ...event, active: false }), 6000))
}

export function clearTyping() {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  useTypingState.setState({ channels: {} })
}
