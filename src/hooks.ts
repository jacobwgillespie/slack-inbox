import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { FormatContext } from './format'
import { computeCounts, computeVisible, currentItem, useStore, VIEWS, type InboxState } from './store'

const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000
const FOCUS_REFRESH_THRESHOLD = 60 * 1000

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
  x: (state) => state.toggleChecked(),
  r: (state) => state.reply(),
  t: (state) => state.replyInThread(),
  u: (state) => state.openInSlack(),
  z: (state) => state.undo(),
  R: (state) => void state.refresh(),
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

export function useAutoRefresh() {
  useEffect(() => {
    const refresh = () => void useStore.getState().refresh()
    const refreshIfStale = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - useStore.getState().lastScanAt > FOCUS_REFRESH_THRESHOLD) refresh()
    }
    refresh()
    const interval = setInterval(refresh, AUTO_REFRESH_INTERVAL)
    window.addEventListener('focus', refreshIfStale)
    document.addEventListener('visibilitychange', refreshIfStale)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', refreshIfStale)
      document.removeEventListener('visibilitychange', refreshIfStale)
    }
  }, [])
}

export function useSelectionRepair() {
  const visible = useVisibleItems()
  const selectedId = useStore((state) => state.selectedId)
  useEffect(() => {
    if (visible.some((item) => item.conversation.id === selectedId)) return
    useStore.getState().select(visible[0]?.conversation.id)
  }, [visible, selectedId])
}
