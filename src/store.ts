import { dmCollection, channelCollection, inboxCollection, laterCollection, userCollection, messageCollection, reconcile } from './collections'
import { openDesktopSlack } from './desktop'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { LocalApiError, localApi } from './api'
import { permalink } from './format'
import { captureLegacyPreferences, clearLegacyPreferences } from './legacy-preferences'
import { compareTs, maxTs, precedingTs } from './slack/timestamps'
import type {
  Classification,
  ClassificationEntry,
  DirectMessage,
  ConversationSummary,
  InboxItem,
  InboxPayload,
  LaterItem,
  Message,
  PreferenceSource,
  Session,
  SyncStatus,
  User,
} from './slack/types'

export type View = 'important' | 'other' | 'later' | 'muted' | 'dms' | 'channels'
export const isConversationView = (view: View) => view === 'dms' || view === 'channels'
export const VIEWS: View[] = ['important', 'other', 'later', 'muted', 'dms', 'channels']

type Mode = 'list' | 'reading'

interface Toast {
  id: number
  message: string
  tone: 'info' | 'error'
  undo?: () => void
}

interface Override<T> {
  value: T
  expiresAt: number
}

type ThreadState = Message[] | 'loading'

export interface HistoryState {
  item?: InboxItem
  hasMore: boolean
  before?: string
  loading: boolean
  loadingOlder?: boolean
  error?: string
}

export interface InboxState {
  status: 'loading' | 'ready' | 'error'
  error?: LocalApiError
  session?: Session
  sync?: SyncStatus
  preferenceSource?: PreferenceSource
  users: Record<string, User>
  emoji: Record<string, string>
  items: Record<string, InboxItem>
  directMessages: Record<string, DirectMessage>
  channels: Record<string, ConversationSummary>
  histories: Record<string, HistoryState>
  later: Record<string, LaterItem>
  muted: Record<string, true>
  cursors: Record<string, Override<string>>
  laterOverrides: Record<string, Override<LaterItem | undefined>>
  muteOverrides: Record<string, Override<boolean>>
  classificationOverrides: Record<string, Override<Classification | null>>
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

  load: () => Promise<void>
  loadEmoji: () => Promise<void>
  loadHistory: (channel: string, mode?: 'latest' | 'older' | 'cached') => Promise<void>
  refresh: () => void
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
  recategorize: (ids?: string[]) => void
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

type VisibleSource = Pick<InboxState, 'items' | 'directMessages' | 'channels' | 'later' | 'muted' | 'view' | 'session'>

const OVERRIDE_LIFETIME = 2 * 60 * 1000
const TOAST_DURATION = 7000

export const latestTs = (item: InboxItem) => item.messages[item.messages.length - 1]?.ts ?? '0'
export const threadKey = (channel: string, ts: string) => `${channel}:${ts}`

export function mentionsSelf(item: InboxItem, session?: Session): boolean {
  if (!session) return false
  return item.messages.some((message) => message.text.includes(`<@${session.userId}`))
}

function matchesImportantRules(item: InboxItem, message: Message, session?: Session): boolean {
  if (item.conversation.kind === 'dm' || item.conversation.kind === 'group') return true
  return Boolean(session && message.text.includes(`<@${session.userId}`))
}

export function isMessageImportant(item: InboxItem, message: Message, session?: Session): boolean {
  if (message.classification) return message.classification.label === 'important'
  return matchesImportantRules(item, message, session)
}

export function isImportant(item: InboxItem, session?: Session): boolean {
  if (item.thread) return true
  return item.messages.some((message) => isMessageImportant(item, message, session))
}

const messageKey = (item: InboxItem, message: Message) => `${item.conversation.id}:${message.ts}`

function withClassification(item: InboxItem, lookup: (key: string) => Classification | null | undefined): InboxItem {
  let changed = false
  const messages = item.messages.map((message) => {
    const classification = lookup(messageKey(item, message))
    if (classification === undefined) return message
    changed = true
    return { ...message, classification: classification ?? undefined }
  })
  return changed ? { ...item, messages } : item
}

export function threadTargetFor(item: InboxItem, threadTarget?: string): string | undefined {
  return threadTarget ?? item.thread?.ts
}

export function findMessage(item: InboxItem, ts: string): Message | undefined {
  return item.thread?.root.ts === ts ? item.thread.root :
    item.messages.find((message) => message.ts === ts) ?? messageCollection.get(`${item.conversation.id}:${ts}`)
}

const isMutedChannelItem = (item: InboxItem, muted: Record<string, true>) =>
  !item.thread && Boolean(muted[item.conversation.id])

const byLatest = (a: InboxItem, b: InboxItem) => compareTs(latestTs(b), latestTs(a))
const bySavedAt = (a: LaterItem, b: LaterItem) => b.savedAt - a.savedAt

export function computeVisible(state: VisibleSource): InboxItem[] {
  const inbox = Object.values(state.items)
  switch (state.view) {
    case 'channels':
      return Object.values(state.channels).sort((a, b) =>
        compareTs(b.latestTs, a.latestTs) || a.conversation.name.localeCompare(b.conversation.name),
      )
    case 'dms':
      return Object.values(state.directMessages).sort((a, b) =>
        compareTs(b.latestTs, a.latestTs) || a.conversation.name.localeCompare(b.conversation.name),
      )
    case 'later':
      return Object.values(state.later).sort(bySavedAt)
    case 'muted':
      return inbox.filter((item) => isMutedChannelItem(item, state.muted)).sort(byLatest)
    case 'important':
    case 'other': {
      const important = state.view === 'important'
      return inbox
        .filter((item) => !isMutedChannelItem(item, state.muted) && isImportant(item, state.session) === important)
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
  if (isConversationView(state.view)) return state.histories[state.selectedId]?.item ?? (state.view === 'channels' ? state.channels[state.selectedId] : state.directMessages[state.selectedId])
  return state.view === 'later' ? state.later[state.selectedId] : state.items[state.selectedId]
}

function omit<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  const copy = { ...record }
  for (const key of keys) delete copy[key]
  return copy
}

function activeOverrides<T>(overrides: Record<string, Override<T>>, now: number): Record<string, Override<T>> {
  return Object.fromEntries(Object.entries(overrides).filter(([, override]) => override.expiresAt > now))
}

function override<T>(value: T): Override<T> {
  return { value, expiresAt: Date.now() + OVERRIDE_LIFETIME }
}

function pluralize(count: number, noun: string) {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`
}

function toLaterItem(item: InboxItem): LaterItem | undefined {
  const message = item.messages[item.messages.length - 1]
  if (!message) return undefined
  return {
    id: `${item.conversation.id}:${message.ts}`,
    conversation: item.conversation,
    messages: [message],
    ts: message.ts,
    savedAt: Date.now(),
  }
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

let legacyPreferences = captureLegacyPreferences()
let toastCounter = 0
let toastTimer: ReturnType<typeof setTimeout> | undefined

export const inboxStore = create<InboxState>()(
  persist(
    (set, get) => {
      const showToast = (message: string, options: { undo?: () => void; tone?: Toast['tone'] } = {}) => {
        clearTimeout(toastTimer)
        const id = ++toastCounter
        set({ toast: { id, message, tone: options.tone ?? 'info', undo: options.undo } })
        toastTimer = setTimeout(() => {
          if (get().toast?.id === id) set({ toast: undefined })
        }, TOAST_DURATION)
      }

      const reportError = (error: unknown) => {
        showToast(error instanceof Error ? error.message : String(error), { tone: 'error' })
      }

      const run = (request: Promise<unknown>) => {
        request.catch(reportError)
      }

      const targetIds = (): string[] => {
        const state = get()
        const visibleIds = new Set(computeVisible(state).map((item) => item.id))
        const checked = Object.keys(state.checked).filter((id) => visibleIds.has(id))
        if (checked.length) return checked
        return state.selectedId && visibleIds.has(state.selectedId) ? [state.selectedId] : []
      }

      const selectionAfterRemoval = (ids: string[]) => {
        const state = get()
        const visible = computeVisible(state).map((item) => item.id)
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

      const selectionPatch = (id: string | undefined) => {
        const state = get()
        const item = id ? currentItem({ ...state, selectedId: id }) : undefined
        return {
          selectedId: id,
          focusedTs: isConversationView(state.view) ? item?.messages.at(-1)?.ts : item?.messages[0]?.ts,
          threadTarget: undefined,
          mode: item ? state.mode : ('list' as const),
        }
      }

      const removeAndAdvance = <T>(ids: string[], apply: () => T): T => {
        const nextId = selectionAfterRemoval(ids)
        const result = apply()
        set({ checked: {}, ...selectionPatch(nextId) })
        return result
      }

      const reselect = (ids: string[]) => {
        const visible = new Set(computeVisible(get()).map((item) => item.id))
        const id = ids.find((candidate) => visible.has(candidate))
        if (id) set(selectionPatch(id))
      }

      const setLaterOverrides = (entries: [string, LaterItem | undefined][]) => {
        set((state) => {
          const laterOverrides = { ...state.laterOverrides }
          const later = { ...state.later }
          for (const [id, item] of entries) {
            laterOverrides[id] = override(item)
            if (item) later[id] = item
            else delete later[id]
          }
          return { laterOverrides, later }
        })
      }

      const setMuteOverrides = (ids: string[], muted: boolean) => {
        set((state) => {
          const muteOverrides = { ...state.muteOverrides }
          const nextMuted = { ...state.muted }
          for (const id of ids) {
            muteOverrides[id] = override(muted)
            if (muted) nextMuted[id] = true
            else delete nextMuted[id]
          }
          return { muteOverrides, muted: nextMuted }
        })
      }

      const syncReadPosition = (item: InboxItem, ts: string) => {
        if (item.thread) run(localApi.markThreadRead(item.conversation.id, item.thread.ts, ts))
        else run(localApi.markRead(item.conversation.id, ts))
      }

      const clearFromInbox = (items: InboxItem[]) => {
        const state = get()
        const ids = items.map((item) => item.id)
        const previousCursors = Object.fromEntries(ids.map((id) => [id, state.cursors[id]]))
        const cursors = { ...state.cursors }
        for (const item of items) {
          cursors[item.id] = override(latestTs(item))
          syncReadPosition(item, latestTs(item))
        }
        set({ items: omit(state.items, ids), cursors })
        return () => {
          set((current) => {
            const restoredCursors = { ...current.cursors }
            for (const [id, cursor] of Object.entries(previousCursors)) {
              if (cursor) restoredCursors[id] = cursor
              else delete restoredCursors[id]
            }
            return {
              items: { ...current.items, ...Object.fromEntries(items.map((item) => [item.id, item])) },
              cursors: restoredCursors,
            }
          })
          reselect(ids)
          for (const item of items) {
            const first = item.messages[0]
            if (first) syncReadPosition(item, precedingTs(first.ts))
          }
        }
      }

      const applyInbox = (payload: InboxPayload) => {
        set((state) => {
          const now = Date.now()
          const cursors = activeOverrides(state.cursors, now)
          const laterOverrides = activeOverrides(state.laterOverrides, now)
          const muteOverrides = activeOverrides(state.muteOverrides, now)
          const classificationOverrides = activeOverrides(state.classificationOverrides, now)
          const classificationFor = (key: string) => classificationOverrides[key]?.value

          const items: Record<string, InboxItem> = {}
          for (const item of payload.items) {
            const cursor = maxTs(cursors[item.id]?.value)
            const messages = item.messages.filter((message) => compareTs(message.ts, cursor) > 0)
            if (messages.length) items[item.id] = withClassification({ ...item, messages }, classificationFor)
          }

          const later: Record<string, LaterItem> = Object.fromEntries(payload.later.map((item) => [item.id, item]))
          for (const [id, { value }] of Object.entries(laterOverrides)) {
            if (value) later[id] = later[id] ?? value
            else delete later[id]
          }

          const muted: Record<string, true> = Object.fromEntries(payload.muted.map((id) => [id, true]))
          for (const [id, { value }] of Object.entries(muteOverrides)) {
            if (value) muted[id] = true
            else delete muted[id]
          }

          return {
            status: payload.session ? 'ready' : payload.sync.error ? 'error' : 'loading',
            error: payload.sync.error && !payload.session ? new LocalApiError(payload.sync.error) : undefined,
            session: payload.session,
            sync: payload.sync,
            preferenceSource: payload.preferenceSource,
            users: { ...state.users, ...payload.users },
            items,
            directMessages: Object.fromEntries(payload.directMessages.map((item) => [item.id, item])),
            channels: Object.fromEntries(payload.channels.map((item) => [item.id, item])),
            later,
            muted,
            cursors,
            laterOverrides,
            muteOverrides,
            classificationOverrides,
          }
        })
      }

      const importLegacyPreferences = () => {
        const pending = legacyPreferences
        if (!pending || !get().session) return
        legacyPreferences = undefined
        localApi
          .importLegacyPreferences(pending)
          .then(() => {
            clearLegacyPreferences()
            const destination = get().preferenceSource === 'slack' ? 'Slack' : 'the local database'
            showToast(
              `Moved ${pluralize(pending.later.length, 'Later item')} and ${pluralize(pending.muted.length, 'muted conversation')} to ${destination}`,
            )
          })
          .catch((error) => {
            legacyPreferences = pending
            reportError(error)
          })
      }

      return {
        status: 'loading',
        users: {},
        emoji: {},
        items: {},
        directMessages: {},
        channels: {},
        histories: {},
        later: {},
        muted: {},
        cursors: {},
        laterOverrides: {},
        muteOverrides: {},
        classificationOverrides: {},
        view: 'important',
        mode: 'list',
        checked: {},
        threads: {},
        helpOpen: false,
        composerFocusRequest: 0,

        load: async () => {
          try {
            applyInbox(await localApi.inbox())
            importLegacyPreferences()
          } catch (error) {
            if (get().status === 'ready') return
            set({
              status: 'error',
              error:
                error instanceof LocalApiError
                  ? error
                  : new LocalApiError({ code: 'server_unreachable', message: String(error) }),
            })
          }
        },

        loadEmoji: async () => {
          const emoji = await localApi.emoji().catch(() => undefined)
          if (emoji) set({ emoji })
        },

        loadHistory: async (channel, mode = 'latest') => {
          if (window.slackDesktop) return
          const previous = get().histories[channel]
          const conversation = get().directMessages[channel] ?? get().channels[channel]
          if (!conversation || previous?.loading || (mode === 'older' && !previous?.hasMore)) return
          set((state) => ({
            histories: {
              ...state.histories,
              [channel]: {
                ...previous,
                hasMore: previous?.hasMore ?? true,
                loading: true,
                loadingOlder: mode === 'older',
                error: undefined,
              },
            },
          }))
          try {
            const oldest = previous?.item?.messages[0]?.ts
            let payload = await localApi.history(channel, {
              before: mode === 'older' ? previous?.before : undefined,
              after: mode === 'cached' ? oldest : undefined,
              cached: mode === 'cached',
            })
            if (mode === 'latest' && oldest) {
              payload = await localApi.history(channel, { after: oldest, cached: true })
            }
            const messages = mode === 'older'
              ? [...new Map([...payload.messages, ...(previous?.item?.messages ?? [])].map((message) => [message.ts, message])).values()]
                  .sort((a, b) => compareTs(a.ts, b.ts))
              : payload.messages
            set((state) => ({
              histories: {
                ...state.histories,
                [channel]: {
                  item: { id: channel, conversation: conversation.conversation, messages },
                  hasMore: payload.hasMore,
                  before: payload.before,
                  loading: false,
                },
              },
              users: { ...state.users, ...payload.users },
            }))
          } catch (error) {
            set((state) => ({
              histories: {
                ...state.histories,
                [channel]: {
                  ...state.histories[channel]!,
                  loading: false,
                  error: error instanceof Error ? error.message : String(error),
                },
              },
            }))
          }
        },

        refresh: () => {
          run(localApi.sync())
          const state = get()
          if (isConversationView(state.view) && state.selectedId) run(state.loadHistory(state.selectedId))
        },

        setView: (view) => {
          const first = computeVisible({ ...get(), view })[0]
          set({ view, mode: 'list', checked: {} })
          set(selectionPatch(first?.id))
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
          const index = visible.findIndex((item) => item.id === state.selectedId)
          const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))]
          if (next) set(selectionPatch(next.id))
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
          if (!id || isConversationView(get().view)) return
          const checked = { ...get().checked }
          if (checked[id]) delete checked[id]
          else checked[id] = true
          set({ checked })
        },

        markDone: (ids = targetIds(), message) => {
          const state = get()
          if (!ids.length) return

          if (isConversationView(state.view)) {
            for (const id of ids) {
              const item = currentItem({ ...state, selectedId: id })
              if (!item?.messages.length) continue
              run(localApi.markRead(item.conversation.id, latestTs(item)).then(() => get().load()))
            }
            showToast(message ?? 'Marked as read')
            return
          }

          if (state.view === 'later') {
            const completed = ids.map((id) => state.later[id]).filter((item) => item !== undefined)
            removeAndAdvance(ids, () => setLaterOverrides(completed.map((item) => [item.id, undefined])))
            for (const item of completed) run(localApi.completeLater(item.conversation.id, item.ts))
            showToast(message ?? `Completed ${pluralize(completed.length, 'Later item')}`, {
              undo: () => {
                setLaterOverrides(completed.map((item) => [item.id, item]))
                reselect(ids)
                for (const item of completed) run(localApi.reopenLater(item.conversation.id, item.ts))
              },
            })
            return
          }

          const removed = ids.map((id) => state.items[id]).filter((item) => item !== undefined)
          const restore = removeAndAdvance(ids, () => clearFromInbox(removed))
          showToast(message ?? `Marked ${pluralize(removed.length, 'conversation')} as read`, { undo: restore })
        },

        saveForLater: (ids = targetIds()) => {
          const state = get()
          if (!ids.length || state.view === 'later' || isConversationView(state.view)) return
          const moved = ids.map((id) => state.items[id]).filter((item) => item !== undefined)
          const saved = moved.map(toLaterItem).filter((item) => item !== undefined)
          const requests = saved.map((item) => localApi.saveForLater(item.conversation.id, item.ts))
          for (const request of requests) run(request)

          const restore = removeAndAdvance(ids, () => {
            setLaterOverrides(saved.map((item) => [item.id, item]))
            return clearFromInbox(moved)
          })
          showToast(`Saved ${pluralize(saved.length, 'conversation')} for later`, {
            undo: () => {
              restore()
              setLaterOverrides(saved.map((item) => [item.id, undefined]))
              saved.forEach((item, index) => {
                const request = requests[index]
                if (!request) return
                run(
                  request.then(({ created }) =>
                    created ? localApi.removeLater(item.conversation.id, item.ts) : undefined,
                  ),
                )
              })
            },
          })
        },

        toggleMute: (ids = targetIds()) => {
          const state = get()
          if (!ids.length || state.view === 'later') return
          const muting = isConversationView(state.view) ? !state.muted[ids[0] ?? ''] : state.view !== 'muted'
          const targets = ids
            .map((id) => isConversationView(state.view) ? state.directMessages[id] ?? state.channels[id] : state.items[id])
            .filter((item): item is InboxItem => item !== undefined && !item.thread)
          if (!targets.length) return
          const targetIds = targets.map((item) => item.id)
          const channels = targets.map((item) => item.conversation.id)
          const apply = (muted: boolean) => {
            setMuteOverrides(channels, muted)
            for (const channel of channels) run(localApi.setMuted(channel, muted))
          }
          if (isConversationView(state.view)) apply(muting)
          else removeAndAdvance(targetIds, () => apply(muting))
          showToast(`${muting ? 'Muted' : 'Unmuted'} ${pluralize(channels.length, 'conversation')}`, {
            undo: () => {
              apply(!muting)
              reselect(targetIds)
            },
          })
        },

        recategorize: (ids = targetIds()) => {
          const state = get()
          if (state.view !== 'important' && state.view !== 'other') return
          const targets = ids
            .map((id) => state.items[id])
            .filter((item): item is InboxItem => item !== undefined && !item.thread)
          if (!targets.length) return
          const label = state.view === 'important' ? 'other' : 'important'
          const previous: ClassificationEntry[] = targets.flatMap((item) =>
            item.messages.map((message) => ({
              channel: item.conversation.id,
              ts: message.ts,
              classification: message.classification ?? null,
            })),
          )
          const applyClassifications = (entries: [string, Classification | null][]) => {
            set((current) => {
              const classificationOverrides = { ...current.classificationOverrides }
              for (const [key, classification] of entries) classificationOverrides[key] = override(classification)
              const lookup = (key: string) => classificationOverrides[key]?.value
              const items = { ...current.items }
              for (const item of targets) {
                const existing = items[item.id]
                if (existing) items[item.id] = withClassification(existing, lookup)
              }
              return { classificationOverrides, items }
            })
          }
          const userClassification: Classification = { label, reason: 'Set by you', source: 'user' }
          const targetIds = targets.map((item) => item.id)
          removeAndAdvance(targetIds, () =>
            applyClassifications(previous.map((entry) => [`${entry.channel}:${entry.ts}`, userClassification])),
          )
          run(localApi.setClassification(previous.map(({ channel, ts }) => ({ channel, ts })), label))
          showToast(`Moved ${pluralize(targets.length, 'conversation')} to ${label === 'important' ? 'Important' : 'Other'}`, {
            undo: () => {
              applyClassifications(previous.map((entry) => [`${entry.channel}:${entry.ts}`, entry.classification]))
              reselect(targetIds)
              run(localApi.restoreClassifications(previous))
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
          const message = findMessage(item, targetTs)
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
            await localApi.postMessage(item.conversation.id, text, threadTargetFor(item, state.threadTarget))
          } catch (error) {
            reportError(error)
            return false
          }
          set({ threadTarget: undefined })
          if (isConversationView(state.view)) {
            await get().loadHistory(item.id, get().sync?.realtime === 'connected' ? 'cached' : 'latest')
            const updated = get().histories[item.id]?.item ?? item
            run(localApi.markRead(item.conversation.id, latestTs(updated)).then(() => get().load()))
            showToast('Reply sent')
            return true
          }
          get().markDone([item.id], 'Reply sent')
          return true
        },

        toggleThread: (ts) => {
          const state = get()
          const item = currentItem(state)
          const targetTs = ts ?? state.focusedTs
          if (!item || !targetTs) return
          const message = findMessage(item, targetTs)
          if (!message?.reply_count) return
          const key = threadKey(item.conversation.id, targetTs)
          if (state.threads[key]) {
            set({ threads: omit(state.threads, [key]) })
            return
          }
          set({ threads: { ...state.threads, [key]: 'loading' } })
          localApi
            .threadReplies(item.conversation.id, targetTs)
            .then(({ messages, users }) =>
              set((current) => ({
                threads: { ...current.threads, [key]: messages },
                users: { ...current.users, ...users },
              })),
            )
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
          if (!openDesktopSlack(item.conversation.id)) window.open(permalink(state.session, item.conversation.id, ts), '_blank', 'noopener')
        },

        toggleHelp: () => set((state) => ({ helpOpen: !state.helpOpen })),

        dismissToast: () => set({ toast: undefined }),
      }
    },
    {
      name: 'slack-inbox',
      version: 2,
      storage: createJSONStorage(() => resilientLocalStorage),
      migrate: (persisted) => ({ view: (persisted as { view?: View } | undefined)?.view ?? 'important' }),
      partialize: (state) => ({ view: state.view }),
    },
  ),
)

export const useStore = inboxStore

// Keep command/optimistic state compatible while UI reads live collections.
useStore.subscribe((state, previous) => {
  if (state.directMessages !== previous.directMessages) reconcile(dmCollection, Object.values(state.directMessages))
  if (state.channels !== previous.channels) reconcile(channelCollection, Object.values(state.channels))
  if (state.items !== previous.items) reconcile(inboxCollection, Object.values(state.items))
  if (state.later !== previous.later) reconcile(laterCollection, Object.values(state.later))
  if (state.users !== previous.users) reconcile(userCollection, Object.values(state.users))
})
