import { useLiveQuery } from '@tanstack/react-db'
import { dmCollection, channelCollection, inboxCollection, laterCollection, userCollection, preferenceCollection } from './collections'
import { useEffect, useMemo } from 'react'
import { subscribeToChanges } from './api'
import { updateTyping, clearTyping } from './typing'
import type { FormatContext } from './format'
import { isConversationView, useStore, VIEWS } from './store'
import { computeCounts, computeVisible } from './selectors'
import { commands, readState } from './commands'
import { preferenceMaps, useRuntime } from './data'

export function useFormatContext(renderedEmoji?: Record<string, string>): FormatContext {
  const { data: users } = useLiveQuery(userCollection)
  const { emoji } = useRuntime()
  return { users: Object.fromEntries(users.map((user) => [user.id, user])), emoji: renderedEmoji ? { ...emoji, ...renderedEmoji } : emoji }
}

function useVisibleSource() {
  const { data: items, isReady: itemsReady } = useLiveQuery(inboxCollection)
  const { data: dms, isReady: dmsReady } = useLiveQuery(dmCollection)
  const { data: channels, isReady: channelsReady } = useLiveQuery(channelCollection)
  const { data: later, isReady: laterReady } = useLiveQuery(laterCollection)
  const { data: preferences, isReady: preferencesReady } = useLiveQuery(preferenceCollection)
  const view = useStore((state) => state.view)
  const { session } = useRuntime()
  return { ready: itemsReady && dmsReady && channelsReady && laterReady && preferencesReady, ...preferenceMaps(preferences), view, session, items: Object.fromEntries(items.map((row) => [row.id, row])), channels: Object.fromEntries(channels.map((row) => [row.id, row])), directMessages: Object.fromEntries(dms.map((row) => [row.id, row])), later: Object.fromEntries(later.map((row) => [row.id, row])) }
}

export function useVisibleItems() {
  const source = useVisibleSource()
  return useMemo(() => computeVisible(source), [source])
}

export function useViewCounts() {
  const source = useVisibleSource()
  return useMemo(() => computeCounts(source), [source])
}

export function useDockBadge() {
  const source = useVisibleSource()
  const count = !source.session ? 0 : source.ready ? computeVisible({ ...source, view: 'inbox' }).length : undefined
  useEffect(() => {
    if (window.slackDesktop.platform !== 'darwin' || count === undefined) return
    void window.slackDesktop.setInboxCount(count).catch((error) => console.warn('Could not update dock badge', error))
  }, [count])
}

export function useInboxEmpty() {
  const source = useVisibleSource()
  const { status, sync } = useRuntime()
  return source.ready && status === 'ready' && Boolean(sync?.lastCompletedAt) && computeVisible({ ...source, view: 'inbox' }).length === 0
}

export function useCurrentItem() {
  const source = useVisibleSource()
  const id = useStore((state) => state.selectedId)
  if (!id) return undefined
  if (isConversationView(source.view)) {
    const item = source.channels[id] ?? source.directMessages[id] ?? source.items[id]
    return item
  }
  return source.view === 'later' ? source.later[id] : source.items[id]
}

type Binding = (event: KeyboardEvent) => void

const BINDINGS: Record<string, Binding> = {
  j: () => commands.move(1),
  ArrowDown: () => commands.move(1),
  k: () => commands.move(-1),
  ArrowUp: () => commands.move(-1),
  Enter: () => commands.open(),
  o: () => commands.open(),
  Escape: () => commands.escape(),
  e: () => commands.markDone(),
  l: () => commands.saveForLater(),
  m: () => commands.toggleMute(),
  c: () => commands.recategorize(),
  x: () => commands.toggleChecked(),
  r: () => commands.reply(),
  t: () => commands.replyInThread(),
  u: () => commands.openInSlack(),
  z: () => commands.undo(),
  R: () => commands.refresh(),
  Tab: (event) => commands.cycleView(event.shiftKey ? -1 : 1),
  '?': () => commands.toggleHelp(),
  '/': () => commands.setSearchOpen(true),
  ...Object.fromEntries(VIEWS.map((view, index) => [String(index + 1), () => commands.setView(view)])),
}

function isEditable(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

export function useKeyboardShortcuts(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return
      const state = readState()
      if (state.searchOpen) return
      if (state.helpOpen && event.key !== 'Escape' && event.key !== '?') return
      const binding = BINDINGS[event.key]
      if (!binding) return
      event.preventDefault()
      binding(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}

export function useInboxSync() {
  useEffect(() => {
    const { load, loadEmoji } = commands
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
        await load()
        const state = readState()
        if (state.sync?.realtime !== 'connected') clearTyping()
      } while (stale)
      loading = false
    }
    void loadEmoji()
    void reload()
    const unsubscribe = subscribeToChanges(() => {
      void reload()
      if (!Object.keys(readState().emoji).length) void loadEmoji()
    }, updateTyping, clearTyping)
    return () => { unsubscribe(); clearTyping() }
  }, [])
}

export function useSelectionRepair() {
  const visible = useVisibleItems()
  const selectedId = useStore((state) => state.selectedId)
  useEffect(() => {
    const state = readState()
    const currentVisible = computeVisible(state)
    if (currentVisible.some((item) => item.id === state.selectedId)) return
    if (state.selectedId && VIEWS.includes(state.view)) {
      const channel = isConversationView(state.view) ? state.selectedId : state.selectedId.split(':')[0]!
      for (const view of VIEWS) {
        if (view === state.view) continue
        const item = computeVisible({ ...state, view }).find((item) =>
          item.id === channel || item.id === `${channel}:${state.done[channel]}`,
        )
        if (!item) continue
        useStore.setState({ view, selectedId: item.id, checked: {} })
        return
      }
    }
    commands.select(currentVisible[0]?.id)
  }, [visible, selectedId])
}
