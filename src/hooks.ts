import { useLiveQuery } from '@tanstack/react-db'
import { dmCollection, channelCollection, inboxCollection, laterCollection, userCollection } from './collections'
import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { subscribeToChanges } from './api'
import { updateTyping, clearTyping } from './typing'
import type { FormatContext } from './format'
import { computeCounts, computeVisible, isConversationView, useStore, VIEWS, type InboxState } from './store'

export function useFormatContext(renderedEmoji?: Record<string, string>): FormatContext {
  const { data: users } = useLiveQuery(userCollection)
  const emoji = useStore((state) => state.emoji)
  return { users: Object.fromEntries(users.map((user) => [user.id, user])), emoji: renderedEmoji ? { ...emoji, ...renderedEmoji } : emoji }
}

function useVisibleSource() {
  const { data: items } = useLiveQuery(inboxCollection)
  const { data: dms } = useLiveQuery(dmCollection)
  const { data: channels } = useLiveQuery(channelCollection)
  const { data: later } = useLiveQuery(laterCollection)
  const controls = useStore(
    useShallow((state) => ({
      muted: state.muted,
      done: state.done,
      view: state.view,
      session: state.session,
    })),
  )
  return { ...controls, items: Object.fromEntries(items.map((row) => [row.id, row])), channels: Object.fromEntries(channels.map((row) => [row.id, row])), directMessages: Object.fromEntries(dms.map((row) => [row.id, row])), later: Object.fromEntries(later.map((row) => [row.id, row])) }
}

export function useVisibleItems() {
  const source = useVisibleSource()
  return useMemo(() => computeVisible(source), [source])
}

export function useViewCounts() {
  const source = useVisibleSource()
  return useMemo(() => computeCounts(source), [source])
}

export function useCurrentItem() {
  const source = useVisibleSource()
  const id = useStore((state) => state.selectedId)
  const history = useStore((state) => id ? state.histories[id]?.item : undefined)
  if (!id) return undefined
  if (isConversationView(source.view)) {
    const item = source.channels[id] ?? source.directMessages[id]
    return window.slackDesktop ? item : history ?? item
  }
  return source.view === 'later' ? source.later[id] : source.items[id]
}

type Binding = (state: InboxState, event: KeyboardEvent) => void

const BINDINGS: Record<string, Binding> = {
  j: (state) => state.move(1),
  ArrowDown: (state) => state.move(1),
  k: (state) => state.move(-1),
  ArrowUp: (state) => state.move(-1),
  Enter: (state) => state.open(),
  o: (state) => state.open(),
  Escape: (state) => state.escape(),
  e: (state) => state.markDone(),
  l: (state) => state.saveForLater(),
  m: (state) => state.toggleMute(),
  c: (state) => state.recategorize(),
  x: (state) => state.toggleChecked(),
  r: (state) => state.reply(),
  t: (state) => state.replyInThread(),
  u: (state) => state.openInSlack(),
  z: (state) => state.undo(),
  R: (state) => state.refresh(),
  Tab: (state, event) => state.cycleView(event.shiftKey ? -1 : 1),
  '?': (state) => state.toggleHelp(),
  ...Object.fromEntries(VIEWS.map((view, index) => [String(index + 1), (state: InboxState) => state.setView(view)])),
}

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

export function useKeyboardShortcuts(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return
      const state = useStore.getState()
      if (state.helpOpen && event.key !== 'Escape' && event.key !== '?') return
      const binding = BINDINGS[event.key]
      if (!binding) return
      event.preventDefault()
      binding(state, event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}

export function useInboxSync() {
  useEffect(() => {
    const { load, loadEmoji } = useStore.getState()
    let loading = false
    let stale = false
    const reload = async () => {
      if (loading) {
        stale = true
        return
      }
      loading = true
      do {
        stale = false
        const previousRealtime = useStore.getState().sync?.realtime
        await load()
        const state = useStore.getState()
        if (state.sync?.realtime !== 'connected') clearTyping()
        if (isConversationView(state.view) && state.selectedId && state.histories[state.selectedId]?.item) {
          await state.loadHistory(state.selectedId,
            previousRealtime !== 'connected' && state.sync?.realtime === 'connected' ? 'latest' : 'cached',
          )
        }
      } while (stale)
      loading = false
    }
    void loadEmoji()
    void reload()
    const unsubscribe = subscribeToChanges(() => {
      void reload()
      if (!Object.keys(useStore.getState().emoji).length) void loadEmoji()
    }, updateTyping, clearTyping)
    return () => { unsubscribe(); clearTyping() }
  }, [])
}

export function useSelectionRepair() {
  const visible = useVisibleItems()
  const selectedId = useStore((state) => state.selectedId)
  useEffect(() => {
    if (visible.some((item) => item.id === selectedId)) return
    useStore.getState().select(visible[0]?.id)
  }, [visible, selectedId])
}
