import { useEffect, useRef, useState } from 'react'
import { compareTs } from './slack/timestamps'
import type { WebviewConversation, WebviewMessage } from './slack/webview'

export function useWebviewConversation(channel: string, enabled: boolean, initial?: WebviewConversation) {
  const [snapshot, setSnapshot] = useState<WebviewConversation | undefined>(initial)
  const [error, setError] = useState<string>()
  const [loadingOlder, setLoadingOlder] = useState(false)
  const observed = useRef(new Map<string, WebviewMessage>(initial?.messages.map((message) => [message.ts, message])))
  const reader = useRef<(direction?: 'older' | 'latest') => Promise<void>>(async () => {})
  useEffect(() => {
    const bridge = window.slackDesktop
    if (!enabled || !bridge) return
    let cancelled = false
    let busy = false
    let queued: 'older' | 'latest' | undefined
    let older: { before?: string; started: number } | undefined
    let signature = ''
    let olderTimer: ReturnType<typeof setTimeout> | undefined
    let dirty = false
    const openedAt = Date.now()
    const read = async (direction?: 'older' | 'latest') => {
      if (cancelled) return
      if (busy) { if (direction) queued = direction; else dirty = true; return }
      if (direction === 'older' && older) return
      busy = true
      if (direction === 'older') {
        older = { before: [...observed.current.keys()].sort(compareTs)[0], started: Date.now() }
        setLoadingOlder(true)
        olderTimer = setTimeout(() => void read(), 2100)
      }
      try {
        const next = await bridge.readConversation(channel, direction)
        if (cancelled) return
        if (!next.ready) {
          if (Date.now() - openedAt > 15000) setError('Slack has not rendered this conversation yet. Open Slack to check its screen.')
          return
        }
        // Slack removes offscreen rows. Keep everything observed in this panel
        // so fetching an older window cannot discard the newer conversation.
        for (const message of next.messages) {
          const previous = observed.current.get(message.ts)
          observed.current.set(message.ts, {
            ...message, user: message.user ?? previous?.user, username: message.username ?? previous?.username,
            images: message.images?.map((image) => {
              const cached = previous?.images?.find((candidate) => candidate.src === image.src)
              return { ...image, width: image.width ?? cached?.width, height: image.height ?? cached?.height }
            }),
          })
        }
        const messages = [...observed.current.values()].sort((a, b) => compareTs(a.ts, b.ts))
        const merged = { ...next, messages }
        const nextSignature = JSON.stringify(merged)
        if (nextSignature !== signature) { signature = nextSignature; setSnapshot(merged) }
        setError(undefined)
        if (older && (!older.before || (messages[0] && compareTs(messages[0].ts, older.before) < 0) || Date.now() - older.started > 2000)) {
          older = undefined
          clearTimeout(olderTimer)
          setLoadingOlder(false)
        }
      } catch (cause) {
        if (!cancelled) {
          if (cause instanceof Error && /Conversation (is no longer active|changed)/.test(cause.message)) return
          setError(cause instanceof Error ? cause.message : 'Could not read the Slack timeline.')
          older = undefined
          clearTimeout(olderTimer)
          setLoadingOlder(false)
        }
      } finally {
        busy = false
        if ((queued || dirty) && !cancelled) { const direction = queued; queued = undefined; dirty = false; void read(direction) }
      }
    }
    reader.current = read
    const unsubscribe = bridge.onConversationChange((changed) => {
      if (changed === channel) void read()
    })
    setError(undefined)
    setLoadingOlder(false)
    void bridge.openConversation(channel).then(() => read()).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not open Slack.')
    })
    return () => { cancelled = true; clearTimeout(olderTimer); unsubscribe(); reader.current = async () => {} }
  }, [channel, enabled])
  return { snapshot, error, loadingOlder, scroll: (direction: 'older' | 'latest') => void reader.current(direction) }
}
