import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { subscribeToChanges } from './api'
import type { FormatContext } from './format'
import { computeCounts, computeVisible, currentItem, useStore, VIEWS, type InboxState } from './store'

export function useFormatContext(): FormatContext {
  return useStore(useShallow((state) => ({ users: state.users, emoji: state.emoji })))
}

function useVisibleSource() {
  return useStore(
    useShallow((state) => ({
      items: state.items,
      later: state.later,
      muted: state.muted,
      view: state.view,
      session: state.session,
    })),
  )
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
  return useStore(currentItem)
}

type Binding = (state: InboxState, event: KeyboardEvent) => void

const BINDINGS: Record<string, Binding> = {
  j: (state) => state.move(1),
  ArrowDown: (state) => state.move(1),
  k: (state) => state.move(-1),
  ArrowUp: (state) => state.move(-1),
  Enter: (state) => (state.mode === 'reading' ? state.toggleThread() : state.open()),
  o: (state) => (state.mode === 'reading' ? state.toggleThread() : state.open()),
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

export function useKeyboardShortcuts() {
  useEffect(() => {
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
  }, [])
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
        await load()
      } while (stale)
      loading = false
    }
    void loadEmoji()
    void reload()
    return subscribeToChanges(() => {
      void reload()
      if (!Object.keys(useStore.getState().emoji).length) void loadEmoji()
    })
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
