import { dmCollection, channelCollection, inboxCollection, laterCollection, userCollection, messageCollection, reconcile } from './collections'
import { openDesktopSlack } from './desktop'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { LocalApiError, localApi } from './api'
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
  Session,
  SyncStatus,
  User,
} from './slack/types'

export type View = 'important' | 'other' | 'later' | 'muted' | 'inbox' | 'done'
export const isConversationView = (view: View) => view === 'inbox' || view === 'done'
export const VIEWS: View[] = ['inbox', 'later', 'done']

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

export interface InboxState {
  status: 'loading' | 'ready' | 'error'
  error?: LocalApiError
  session?: Session
  sync?: SyncStatus
  users: Record<string, User>
  emoji: Record<string, string>
  items: Record<string, InboxItem>
  directMessages: Record<string, DirectMessage>
  channels: Record<string, ConversationSummary>
  done: Record<string, string>
  doneOverrides: Record<string, Override<string | undefined>>
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
  threadTarget?: string
  threads: Record<string, ThreadState>
  toast?: Toast
  helpOpen: boolean
  composerFocusRequest: number
  composerFocusChannel?: string

  load: () => Promise<void>
  loadEmoji: () => Promise<void>
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
  saveMessageForLater: (channel: string, message: Message) => void
  toggleMute: (ids?: string[]) => void
  recategorize: (ids?: string[]) => void
  undo: () => void
  reply: () => void
  replyInThread: (ts?: string) => void
  clearThreadTarget: () => void
  send: (text: string) => Promise<boolean>
  toggleThread: (ts?: string) => void
  openInSlack: () => void
  toggleHelp: () => void
  dismissToast: () => void
}

type VisibleSource = Pick<InboxState, 'items' | 'directMessages' | 'channels' | 'done' | 'later' | 'muted' | 'view' | 'session'>

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
  const summaries = { ...state.directMessages, ...state.channels }
  const archived = (item: InboxItem) => {
    const through = state.done[item.conversation.id]
    return through !== undefined && compareTs(summaries[item.conversation.id]?.latestTs ?? latestTs(item), through) <= 0
  }
  const inbox = Object.values(state.items).filter((item) => !archived(item))
  switch (state.view) {
    case 'done':
      return Object.values(summaries).filter((item) => archived(item) && !state.later[`${item.id}:${state.done[item.id]}`]).sort((a, b) => compareTs(b.latestTs, a.latestTs) || a.conversation.name.localeCompare(b.conversation.name))
    case 'inbox':
      return Object.values(summaries).filter((item) => !archived(item)).sort((a, b) =>
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
  if (isConversationView(state.view)) return state.channels[state.selectedId] ?? state.directMessages[state.selectedId]
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
          threadTarget: undefined,
          composerFocusChannel: undefined,
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

      const doneRequests = new Map<string, Promise<void>>()
      const setDone = (channel: string, ts?: string, markRead = true) => {
        const previous = get().done[channel]
        const pending = override(ts)
        const apply = (value?: string) => set((state) => ({ done: value === undefined ? omit(state.done, [channel]) : { ...state.done, [channel]: value } }))
        apply(ts)
        set((state) => ({ doneOverrides: { ...state.doneOverrides, [channel]: pending } }))
        const request = (doneRequests.get(channel) ?? Promise.resolve()).catch(() => {}).then(() => localApi.setDone(channel, ts, markRead)).then(async () => {
          if (get().doneOverrides[channel] === pending) set((state) => ({ doneOverrides: omit(state.doneOverrides, [channel]) }))
          await get().load()
        }).catch((error) => {
          if (get().doneOverrides[channel] === pending) {
            apply(previous)
            set((state) => ({ doneOverrides: omit(state.doneOverrides, [channel]) }))
          }
          throw error
        })
        doneRequests.set(channel, request)
        run(request.finally(() => { if (doneRequests.get(channel) === request) doneRequests.delete(channel) }))
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

          const done = { ...payload.done }
          for (const [id, entry] of Object.entries(state.doneOverrides)) {
            if (entry.value === undefined) delete done[id]
            else done[id] = entry.value
          }
          return {
            status: payload.session ? 'ready' : payload.sync.error ? 'error' : 'loading',
            error: payload.sync.error && !payload.session ? new LocalApiError(payload.sync.error) : undefined,
            session: payload.session,
            sync: payload.sync,
            users: { ...state.users, ...payload.users },
            items,
            directMessages: Object.fromEntries(payload.directMessages.map((item) => [item.id, item])),
            channels: Object.fromEntries(payload.channels.map((item) => [item.id, item])),
            done,
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
            showToast(
              `Moved ${pluralize(pending.later.length, 'Later item')} and ${pluralize(pending.muted.length, 'muted conversation')} to Slack`,
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
        done: {},
        doneOverrides: {},
        later: {},
        muted: {},
        cursors: {},
        laterOverrides: {},
        muteOverrides: {},
        classificationOverrides: {},
        view: 'inbox',
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

        refresh: () => {
          run(localApi.sync())
          const state = get()
          if (isConversationView(state.view) && state.selectedId) run(window.slackDesktop.refreshConversation(state.selectedId))
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
            const targets = ids.map((id) => state.channels[id] ?? state.directMessages[id]).filter((item) => item !== undefined)
            if (!targets.length) return
            const previous = targets.map((item) => [item.id, state.done[item.id]] as const)
            removeAndAdvance(ids, () => {
              for (const item of targets) setDone(item.id, state.view === 'done' ? undefined : item.latestTs)
            })
            showToast(message ?? (state.view === 'done' ? 'Restored to inbox' : 'Marked done'), {
              undo: () => { for (const [id, ts] of previous) setDone(id, ts, false); reselect(ids) },
            })
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

        saveMessageForLater: (channel, message) => {
          const state = get()
          const conversation = state.channels[channel]?.conversation ?? state.directMessages[channel]?.conversation ?? currentItem(state)?.conversation
          if (!conversation || conversation.id !== channel) return
          const item: LaterItem = { id: `${channel}:${message.ts}`, conversation, messages: [message], ts: message.ts, savedAt: Date.now() }
          run(localApi.saveForLater(channel, message.ts).then(({ created }) => {
            setLaterOverrides([[item.id, item]])
            showToast('Saved message for later', {
              undo: created ? () => {
                run(localApi.removeLater(channel, message.ts).then(() => setLaterOverrides([[item.id, undefined]])))
              } : undefined,
            })
          }))
        },

        saveForLater: (ids = targetIds()) => {
          const state = get()
          if (!ids.length || state.view === 'later' || state.view === 'done') return
          if (state.view === 'inbox') {
            const targets = ids.map((id) => state.channels[id] ?? state.directMessages[id]).filter((item): item is ConversationSummary => item !== undefined && item.latestTs !== '0')
            run((async () => {
              for (const target of targets) {
                const ts = target.latestTs
                const { created } = await localApi.saveForLater(target.id, ts)
                const saved = toLaterItem(target)
                if (saved && saved.ts === ts) setLaterOverrides([[saved.id, saved]])
                const previous = get().done[target.id]
                const apply = () => setDone(target.id, ts)
                if (get().view === 'inbox') removeAndAdvance([target.id], apply)
                else apply()
                showToast('Moved conversation to Later', {
                  undo: () => {
                    setDone(target.id, previous, false)
                    if (created) run(localApi.removeLater(target.id, ts).then(() => setLaterOverrides([[`${target.id}:${ts}`, undefined]])))
                    reselect([target.id])
                  },
                })
              }
            })())
            return
          }
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
          set((state) => ({ threadTarget: undefined, composerFocusRequest: state.composerFocusRequest + 1, composerFocusChannel: currentItem(state)?.conversation.id }))
        },

        replyInThread: (ts) => {
          const state = get()
          const item = currentItem(state)
          if (!item) return
          const targetTs = ts ?? latestTs(item)
          const message = findMessage(item, targetTs)
          set({
            threadTarget: message?.thread_ts ?? targetTs,
            composerFocusRequest: state.composerFocusRequest + 1,
            composerFocusChannel: item.conversation.id,
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
            const updated = currentItem(get()) ?? item
            run(localApi.markRead(item.conversation.id, latestTs(updated)).then(() => get().load()))
            return true
          }
          get().markDone([item.id], 'Reply sent')
          return true
        },

        toggleThread: (ts) => {
          const state = get()
          const item = currentItem(state)
          if (!item) return
          const targetTs = ts ?? latestTs(item)
          if (!targetTs) return
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

        openInSlack: () => {
          const state = get()
          const item = currentItem(state)
          if (!item || !state.session) return
          openDesktopSlack(item.conversation.id)
        },

        toggleHelp: () => set((state) => ({ helpOpen: !state.helpOpen })),

        dismissToast: () => set({ toast: undefined }),
      }
    },
    {
      name: 'slack-inbox',
      version: 4,
      storage: createJSONStorage(() => resilientLocalStorage),
      migrate: (persisted) => {
        const view = (persisted as { view?: View } | undefined)?.view
        return { view: view && VIEWS.includes(view) ? view : 'inbox' }
      },
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
