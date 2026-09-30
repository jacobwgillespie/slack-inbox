import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { permalink } from './format'
import { SlackError } from './slack/api'
import {
  compareTs,
  fetchCustomEmoji,
  fetchSession,
  fetchThreadReplies,
  fetchUser,
  fetchUsers,
  markRead,
  maxTs,
  postMessage,
  precedingTs,
  scanInbox,
} from './slack/inbox'
import type { Conversation, InboxItem, LaterItem, Message, Session, User } from './slack/types'

export type View = 'important' | 'other' | 'later' | 'muted'
export const VIEWS: View[] = ['important', 'other', 'later', 'muted']

type Mode = 'list' | 'reading'

interface Toast {
  id: number
  message: string
  tone: 'info' | 'error'
  undo?: () => void
}

interface ScanProgress {
  done: number
  total: number
}

type ThreadState = Message[] | 'loading'

export interface InboxState {
  status: 'loading' | 'ready' | 'error'
  error?: SlackError | Error
  session?: Session
  scanning: boolean
  scanProgress: ScanProgress
  lastScanAt: number
  users: Record<string, User>
  usersLoaded: boolean
  emoji: Record<string, string>
  items: Record<string, InboxItem>
  cursors: Record<string, string>
  later: Record<string, LaterItem>
  muted: Record<string, true>
  view: View
  mode: Mode
  selectedId?: string
  checked: Record<string, true>
  focusedTs?: string
  threadTarget?: string
  threads: Record<string, ThreadState>
  toast?: Toast
  helpOpen: boolean
  composerFocusRequest: number

  refresh: () => Promise<void>
  requestUser: (id: string) => void
  setView: (view: View) => void
  cycleView: (delta: number) => void
  select: (id: string | undefined) => void
  move: (delta: number) => void
  open: (id?: string) => void
  escape: () => void
  toggleChecked: (id?: string) => void
  markDone: (ids?: string[], message?: string) => void
  saveForLater: (ids?: string[]) => void
  toggleMute: (ids?: string[]) => void
  undo: () => void
  reply: () => void
  replyInThread: (ts?: string) => void
  clearThreadTarget: () => void
  send: (text: string) => Promise<boolean>
  toggleThread: (ts?: string) => void
  focusMessage: (ts: string) => void
  openInSlack: () => void
  toggleHelp: () => void
  dismissToast: () => void
}

type VisibleSource = Pick<InboxState, 'items' | 'later' | 'muted' | 'view' | 'session'>

export const latestTs = (item: InboxItem) => item.messages[item.messages.length - 1]?.ts ?? '0'
export const threadKey = (channel: string, ts: string) => `${channel}:${ts}`

export function mentionsSelf(item: InboxItem, session?: Session): boolean {
  if (!session) return false
  return item.messages.some((message) => message.text.includes(`<@${session.userId}`))
}

export function isImportant(item: InboxItem, session?: Session): boolean {
  return item.conversation.kind === 'dm' || item.conversation.kind === 'group' || mentionsSelf(item, session)
}

const byLatest = (a: InboxItem, b: InboxItem) => compareTs(latestTs(b), latestTs(a))

export function computeVisible(state: VisibleSource): InboxItem[] {
  const inbox = Object.values(state.items)
  switch (state.view) {
    case 'later':
      return Object.values(state.later).sort(byLatest)
    case 'muted':
      return inbox.filter((item) => state.muted[item.conversation.id]).sort(byLatest)
    case 'important':
    case 'other': {
      const important = state.view === 'important'
      return inbox
        .filter((item) => !state.muted[item.conversation.id] && isImportant(item, state.session) === important)
        .sort(byLatest)
    }
  }
}

export function computeCounts(state: VisibleSource): Record<View, number> {
  return Object.fromEntries(VIEWS.map((view) => [view, computeVisible({ ...state, view }).length])) as Record<
    View,
    number
  >
}

export function currentItem(state: InboxState): InboxItem | undefined {
  if (!state.selectedId) return undefined
  return state.view === 'later' ? state.later[state.selectedId] : state.items[state.selectedId]
}

function omit<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const copy = { ...record }
  for (const key of keys) delete copy[key]
  return copy
}

function mergeMessages(existing: Message[] = [], incoming: Message[]): Message[] {
  const byTs = new Map([...existing, ...incoming].map((message) => [message.ts, message]))
  return [...byTs.values()].sort((a, b) => compareTs(a.ts, b.ts))
}

function pluralize(count: number, noun: string) {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`
}

const resilientLocalStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value)
    } catch (error) {
      console.warn('Could not save inbox state', error)
    }
  },
  removeItem: (key: string) => localStorage.removeItem(key),
}

let toastCounter = 0
let toastTimer: ReturnType<typeof setTimeout> | undefined
const pendingUsers = new Set<string>()

export const useStore = create<InboxState>()(
  persist(
    (set, get) => {
      const showToast = (message: string, options: { undo?: () => void; tone?: Toast['tone'] } = {}) => {
        clearTimeout(toastTimer)
        const id = ++toastCounter
        set({ toast: { id, message, tone: options.tone ?? 'info', undo: options.undo } })
        toastTimer = setTimeout(() => {
          if (get().toast?.id === id) set({ toast: undefined })
        }, 7000)
      }

      const reportError = (error: unknown) => {
        showToast(error instanceof Error ? error.message : String(error), { tone: 'error' })
      }

      const syncReadCursor = (channel: string, ts: string) => {
        markRead(channel, ts).catch(reportError)
      }

      const targetIds = (): string[] => {
        const state = get()
        const visibleIds = new Set(computeVisible(state).map((item) => item.conversation.id))
        const checked = Object.keys(state.checked).filter((id) => visibleIds.has(id))
        if (checked.length) return checked
        return state.selectedId && visibleIds.has(state.selectedId) ? [state.selectedId] : []
      }

      const selectionAfterRemoval = (ids: string[]) => {
        const state = get()
        const visible = computeVisible(state).map((item) => item.conversation.id)
        const removed = new Set(ids)
        const index = Math.max(0, visible.indexOf(state.selectedId ?? ''))
        return (
          visible.slice(index).find((id) => !removed.has(id)) ??
          visible
            .slice(0, index)
            .reverse()
            .find((id) => !removed.has(id))
        )
      }

      const selectionPatch = (id: string | undefined, items = get().items, later = get().later) => {
        const state = get()
        const item = id ? (state.view === 'later' ? later[id] : items[id]) : undefined
        return {
          selectedId: id,
          focusedTs: item?.messages[0]?.ts,
          threadTarget: undefined,
          mode: item ? state.mode : ('list' as const),
        }
      }

      const reselect = (ids: string[]) => {
        const visible = new Set(computeVisible(get()).map((item) => item.conversation.id))
        const id = ids.find((candidate) => visible.has(candidate))
        if (id) set(selectionPatch(id))
      }

      const clearFromInbox = (items: InboxItem[]) => {
        const state = get()
        const ids = items.map((item) => item.conversation.id)
        const previousCursors = Object.fromEntries(ids.map((id) => [id, state.cursors[id]]))
        const cursors = { ...state.cursors }
        for (const item of items) {
          cursors[item.conversation.id] = latestTs(item)
          syncReadCursor(item.conversation.id, latestTs(item))
        }
        return {
          patch: { items: omit(state.items, ids), cursors },
          restore: () => {
            set((current) => {
              const restoredCursors = { ...current.cursors }
              for (const [id, cursor] of Object.entries(previousCursors)) {
                if (cursor) restoredCursors[id] = cursor
                else delete restoredCursors[id]
              }
              return {
                items: { ...current.items, ...Object.fromEntries(items.map((item) => [item.conversation.id, item])) },
                cursors: restoredCursors,
              }
            })
            reselect(ids)
            for (const item of items) {
              const first = item.messages[0]
              if (first) syncReadCursor(item.conversation.id, precedingTs(first.ts))
            }
          },
        }
      }

      const applyScanResult = (conversation: Conversation, lastRead: string, messages: Message[]) => {
        set((state) => {
          const cursor = maxTs(lastRead, state.cursors[conversation.id])
          const unread = messages.filter((message) => compareTs(message.ts, cursor) > 0)
          const items = { ...state.items }
          if (unread.length) items[conversation.id] = { conversation, messages: unread }
          else delete items[conversation.id]
          return { items }
        })
      }

      return {
        status: 'loading',
        scanning: false,
        scanProgress: { done: 0, total: 0 },
        lastScanAt: 0,
        users: {},
        usersLoaded: false,
        emoji: {},
        items: {},
        cursors: {},
        later: {},
        muted: {},
        view: 'important',
        mode: 'list',
        checked: {},
        threads: {},
        helpOpen: false,
        composerFocusRequest: 0,

        refresh: async () => {
          if (get().scanning) return
          set({ scanning: true, scanProgress: { done: 0, total: 0 } })
          try {
            let session = get().session
            if (!session) {
              session = await fetchSession()
              set({ session })
              fetchUsers()
                .then((users) => set((state) => ({ users: { ...users, ...state.users }, usersLoaded: true })))
                .catch((error) => {
                  set({ usersLoaded: true })
                  reportError(error)
                })
              fetchCustomEmoji()
                .then((emoji) => set({ emoji }))
                .catch(() => undefined)
            }
            await scanInbox(session.userId, {
              onStart: (total) => set({ status: 'ready', scanProgress: { done: 0, total } }),
              onResult: applyScanResult,
              onProgress: () =>
                set((state) => ({ scanProgress: { ...state.scanProgress, done: state.scanProgress.done + 1 } })),
            })
            set({ lastScanAt: Date.now() })
          } catch (error) {
            if (get().status === 'ready') reportError(error)
            else set({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) })
          } finally {
            set({ scanning: false })
          }
        },

        requestUser: (id) => {
          const state = get()
          if (!state.usersLoaded || state.users[id] || pendingUsers.has(id)) return
          pendingUsers.add(id)
          fetchUser(id)
            .then((user) => set((current) => ({ users: { ...current.users, [id]: user } })))
            .catch(() => undefined)
        },

        setView: (view) => {
          const first = computeVisible({ ...get(), view })[0]
          set({ view, mode: 'list', checked: {} })
          set(selectionPatch(first?.conversation.id))
        },

        cycleView: (delta) => {
          const index = VIEWS.indexOf(get().view)
          get().setView(VIEWS[(index + delta + VIEWS.length) % VIEWS.length] ?? 'important')
        },

        select: (id) => set(selectionPatch(id)),

        move: (delta) => {
          const state = get()
          if (state.mode === 'reading') {
            const messages = currentItem(state)?.messages ?? []
            const index = messages.findIndex((message) => message.ts === state.focusedTs)
            const next = messages[Math.min(messages.length - 1, Math.max(0, index + delta))]
            if (next) set({ focusedTs: next.ts })
            return
          }
          const visible = computeVisible(state)
          const index = visible.findIndex((item) => item.conversation.id === state.selectedId)
          const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))]
          if (next) set(selectionPatch(next.conversation.id))
        },

        open: (id) => {
          if (id && id !== get().selectedId) set(selectionPatch(id))
          if (currentItem(get())) set({ mode: 'reading' })
        },

        escape: () => {
          const state = get()
          if (state.helpOpen) set({ helpOpen: false })
          else if (state.threadTarget) set({ threadTarget: undefined })
          else if (Object.keys(state.checked).length) set({ checked: {} })
          else if (state.mode === 'reading') set({ mode: 'list' })
        },

        toggleChecked: (id = get().selectedId) => {
          if (!id) return
          const checked = { ...get().checked }
          if (checked[id]) delete checked[id]
          else checked[id] = true
          set({ checked })
        },

        markDone: (ids = targetIds(), message) => {
          const state = get()
          if (!ids.length) return
          const nextId = selectionAfterRemoval(ids)

          if (state.view === 'later') {
            const removed = ids.map((id) => state.later[id]).filter((item) => item !== undefined)
            const later = omit(state.later, ids)
            set({ later, checked: {}, ...selectionPatch(nextId, state.items, later) })
            showToast(message ?? `Removed ${pluralize(removed.length, 'conversation')} from Later`, {
              undo: () => {
                set((current) => ({
                  later: { ...current.later, ...Object.fromEntries(removed.map((item) => [item.conversation.id, item])) },
                }))
                reselect(ids)
              },
            })
            return
          }

          const removed = ids.map((id) => state.items[id]).filter((item) => item !== undefined)
          const { patch, restore } = clearFromInbox(removed)
          set({ ...patch, checked: {}, ...selectionPatch(nextId, patch.items) })
          showToast(message ?? `Marked ${pluralize(removed.length, 'conversation')} as read`, { undo: restore })
        },

        saveForLater: (ids = targetIds()) => {
          const state = get()
          if (!ids.length || state.view === 'later') return
          const moved = ids.map((id) => state.items[id]).filter((item) => item !== undefined)
          const previousLater = Object.fromEntries(moved.map((item) => [item.conversation.id, state.later[item.conversation.id]]))
          const later = { ...state.later }
          for (const item of moved) {
            later[item.conversation.id] = {
              conversation: item.conversation,
              messages: mergeMessages(state.later[item.conversation.id]?.messages, item.messages),
              savedAt: Date.now(),
            }
          }
          const nextId = selectionAfterRemoval(ids)
          const { patch, restore } = clearFromInbox(moved)
          set({ ...patch, later, checked: {}, ...selectionPatch(nextId, patch.items) })
          showToast(`Saved ${pluralize(moved.length, 'conversation')} for later`, {
            undo: () => {
              restore()
              set((current) => {
                const restored = { ...current.later }
                for (const [id, item] of Object.entries(previousLater)) {
                  if (item) restored[id] = item
                  else delete restored[id]
                }
                return { later: restored }
              })
            },
          })
        },

        toggleMute: (ids = targetIds()) => {
          const state = get()
          if (!ids.length || state.view === 'later') return
          const muting = state.view !== 'muted'
          const apply = (mute: boolean) =>
            set((current) => {
              const muted = { ...current.muted }
              for (const id of ids) {
                if (mute) muted[id] = true
                else delete muted[id]
              }
              return { muted }
            })
          const nextId = selectionAfterRemoval(ids)
          apply(muting)
          set({ checked: {}, ...selectionPatch(nextId) })
          showToast(`${muting ? 'Muted' : 'Unmuted'} ${pluralize(ids.length, 'conversation')}`, {
            undo: () => {
              apply(!muting)
              reselect(ids)
            },
          })
        },

        undo: () => {
          const toast = get().toast
          if (!toast?.undo) return
          toast.undo()
          set({ toast: undefined })
        },

        reply: () => {
          if (!currentItem(get())) return
          set((state) => ({ threadTarget: undefined, composerFocusRequest: state.composerFocusRequest + 1 }))
        },

        replyInThread: (ts) => {
          const state = get()
          const item = currentItem(state)
          if (!item) return
          const targetTs = ts ?? (state.mode === 'reading' ? state.focusedTs : undefined) ?? latestTs(item)
          const message = item.messages.find((candidate) => candidate.ts === targetTs)
          set({
            threadTarget: message?.thread_ts ?? targetTs,
            composerFocusRequest: state.composerFocusRequest + 1,
          })
        },

        clearThreadTarget: () => set({ threadTarget: undefined }),

        send: async (text) => {
          const state = get()
          const item = currentItem(state)
          if (!item || !text.trim()) return false
          try {
            await postMessage(item.conversation.id, text, state.threadTarget)
          } catch (error) {
            reportError(error)
            return false
          }
          set({ threadTarget: undefined })
          get().markDone([item.conversation.id], 'Reply sent')
          return true
        },

        toggleThread: (ts) => {
          const state = get()
          const item = currentItem(state)
          const targetTs = ts ?? state.focusedTs
          if (!item || !targetTs) return
          const message = item.messages.find((candidate) => candidate.ts === targetTs)
          if (!message?.reply_count) return
          const key = threadKey(item.conversation.id, targetTs)
          if (state.threads[key]) {
            set({ threads: omit(state.threads, [key]) })
            return
          }
          set({ threads: { ...state.threads, [key]: 'loading' } })
          fetchThreadReplies(item.conversation.id, targetTs)
            .then((replies) => set((current) => ({ threads: { ...current.threads, [key]: replies } })))
            .catch((error) => {
              set((current) => ({ threads: omit(current.threads, [key]) }))
              reportError(error)
            })
        },

        focusMessage: (ts) => set({ focusedTs: ts, mode: 'reading' }),

        openInSlack: () => {
          const state = get()
          const item = currentItem(state)
          if (!item || !state.session) return
          const ts = state.mode === 'reading' ? state.focusedTs : latestTs(item)
          window.open(permalink(state.session, item.conversation.id, ts), '_blank', 'noopener')
        },

        toggleHelp: () => set((state) => ({ helpOpen: !state.helpOpen })),

        dismissToast: () => set({ toast: undefined }),
      }
    },
    {
      name: 'slack-inbox',
      version: 1,
      storage: createJSONStorage(() => resilientLocalStorage),
      partialize: (state) => ({
        items: state.items,
        cursors: state.cursors,
        later: state.later,
        muted: state.muted,
        view: state.view,
      }),
    },
  ),
)
