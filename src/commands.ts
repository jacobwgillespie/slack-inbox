import type { OutgoingMessage } from './slack/rich-text'
import { dmCollection, channelCollection, inboxCollection, laterCollection, userCollection, preferenceCollection, reconcile } from './collections'
import { readData, updateRuntime, setPreference } from './data'
import { inboxStore, isConversationView, VIEWS, type View, type Toast } from './store'
import { computeVisible, currentItem, latestTs, findMessage } from './selectors'
import { openDesktopSlack } from './desktop'
import { LocalApiError, localApi } from './api'
import { captureLegacyPreferences, clearLegacyPreferences } from './legacy-preferences'
import { compareTs, maxTs, precedingTs } from './slack/timestamps'
import type { Classification, ClassificationEntry, ConversationSummary, InboxItem, InboxPayload, LaterItem, Message } from './slack/types'

interface Override<T> { value: T; expiresAt: number }
interface Commands {
  load: () => Promise<void>
  loadEmoji: () => Promise<void>
  refresh: () => void
  setView: (view: View) => void
  cycleView: (delta: number) => void
  select: (id: string | undefined) => void
  move: (delta: number) => void
  open: (id?: string) => void
  openConversation: (id: string) => void
  setSearchOpen: (open: boolean) => void
  escape: () => void
  toggleChecked: (id?: string) => void
  markDone: (ids?: string[], message?: string) => void
  saveForLater: (ids?: string[]) => void
  toggleMessageSaved: (channel: string, message: Message) => Promise<void>
  toggleInboxMute: (item: InboxItem) => void
  toggleMute: (ids?: string[]) => void
  recategorize: (ids?: string[]) => void
  undo: () => void
  reply: () => void
  replyInThread: (ts?: string) => void
  clearThreadTarget: () => void
  send: (message: OutgoingMessage, item: InboxItem, threadTs?: string) => Promise<void>
  toggleThread: (ts?: string) => void
  openInSlack: () => void
  toggleHelp: () => void
  dismissToast: () => void
}

const OVERRIDE_LIFETIME = 2 * 60 * 1000
const TOAST_DURATION = 7000

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

const pendingUpdates = {
  doneOverrides: {} as Record<string, Override<string | undefined>>,
  cursors: {} as Record<string, Override<string>>,
  laterOverrides: {} as Record<string, Override<LaterItem | undefined>>,
  muteOverrides: {} as Record<string, Override<boolean>>,
  classificationOverrides: {} as Record<string, Override<Classification | null>>,
}

// Commands read collection data on demand; this snapshot is never stored.
export const readState = () => ({ ...readData(), ...inboxStore.getState() })
const get = readState
const set = inboxStore.setState

let legacyPreferences = captureLegacyPreferences()
let toastCounter = 0
let toastTimer: ReturnType<typeof setTimeout> | undefined

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
    focusedThread: undefined,
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
  const apply = (value?: string) => setPreference(channel, { done: value })
  apply(ts)
  pendingUpdates.doneOverrides[channel] = pending
  const request = (doneRequests.get(channel) ?? Promise.resolve()).catch(() => {}).then(() => localApi.setDone(channel, ts, markRead)).then(async () => {
    if (pendingUpdates.doneOverrides[channel] === pending) delete pendingUpdates.doneOverrides[channel]
    await commands.load()
  }).catch((error) => {
    if (pendingUpdates.doneOverrides[channel] === pending) {
      apply(previous)
      delete pendingUpdates.doneOverrides[channel]
    }
    throw error
  })
  doneRequests.set(channel, request)
  run(request.finally(() => { if (doneRequests.get(channel) === request) doneRequests.delete(channel) }))
}

const setLaterOverrides = (entries: [string, LaterItem | undefined][]) => {
  for (const [id, item] of entries) {
    pendingUpdates.laterOverrides[id] = override(item)
    if (item) reconcile(laterCollection, [item], false)
    else if (laterCollection.has(id)) laterCollection.delete(id)
  }
}

const setMuteOverrides = (ids: string[], muted: boolean) => {
  for (const id of ids) {
    pendingUpdates.muteOverrides[id] = override(muted)
    setPreference(id, { muted })
  }
}

const syncReadPosition = (item: InboxItem, ts: string) => {
  if (item.thread) run(localApi.markThreadRead(item.conversation.id, item.thread.ts, ts))
  else run(localApi.markRead(item.conversation.id, ts))
}

const clearFromInbox = (items: InboxItem[]) => {
  const ids = items.map((item) => item.id)
  const previousCursors = Object.fromEntries(ids.map((id) => [id, pendingUpdates.cursors[id]]))
  for (const item of items) {
    pendingUpdates.cursors[item.id] = override(latestTs(item))
    if (inboxCollection.has(item.id)) inboxCollection.delete(item.id)
    syncReadPosition(item, latestTs(item))
  }
  return () => {
    for (const [id, cursor] of Object.entries(previousCursors)) {
      if (cursor) pendingUpdates.cursors[id] = cursor
      else delete pendingUpdates.cursors[id]
    }
    reconcile(inboxCollection, items, false)
    reselect(ids)
    for (const item of items) {
      const first = item.messages[0]
      if (first) syncReadPosition(item, precedingTs(first.ts))
    }
  }
}

const applyInbox = (payload: InboxPayload) => {
  const now = Date.now()
  pendingUpdates.cursors = activeOverrides(pendingUpdates.cursors, now)
  pendingUpdates.laterOverrides = activeOverrides(pendingUpdates.laterOverrides, now)
  pendingUpdates.muteOverrides = activeOverrides(pendingUpdates.muteOverrides, now)
  pendingUpdates.classificationOverrides = activeOverrides(pendingUpdates.classificationOverrides, now)
  const classificationFor = (key: string) => pendingUpdates.classificationOverrides[key]?.value

  const items: InboxItem[] = []
  for (const item of payload.items) {
    const cursor = maxTs(pendingUpdates.cursors[item.id]?.value)
    const messages = item.messages.filter((message) => compareTs(message.ts, cursor) > 0)
    if (messages.length) items.push(withClassification({ ...item, messages }, classificationFor))
  }

  const later: Record<string, LaterItem> = Object.fromEntries(payload.later.map((item) => [item.id, item]))
  for (const [id, { value }] of Object.entries(pendingUpdates.laterOverrides)) {
    if (value) later[id] = later[id] ?? value
    else delete later[id]
  }

  const muted: Record<string, true> = Object.fromEntries(payload.muted.map((id) => [id, true]))
  for (const [id, { value }] of Object.entries(pendingUpdates.muteOverrides)) {
    if (value) muted[id] = true
    else delete muted[id]
  }

  const done = { ...payload.done }
  for (const [id, entry] of Object.entries(pendingUpdates.doneOverrides)) {
    if (entry.value === undefined) delete done[id]
    else done[id] = entry.value
  }
  reconcile(dmCollection, payload.directMessages)
  reconcile(channelCollection, payload.channels)
  reconcile(inboxCollection, items)
  reconcile(laterCollection, Object.values(later))
  reconcile(userCollection, Object.values(payload.users), false)
  const inboxMuted = new Set(payload.inboxMuted)
  const preferenceIds = new Set([...Object.keys(done), ...Object.keys(muted), ...inboxMuted])
  reconcile(preferenceCollection, [...preferenceIds].map((id) => ({ id, done: done[id], muted: Boolean(muted[id]), inboxMuted: inboxMuted.has(id) })))
  updateRuntime({
    status: payload.session ? 'ready' : payload.sync.error ? 'error' : 'loading',
    error: payload.sync.error && !payload.session ? new LocalApiError(payload.sync.error) : undefined,
    session: payload.session,
    sync: payload.sync,
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

export const commands: Commands = {
  load: async () => {
    try {
      applyInbox(await localApi.inbox())
      importLegacyPreferences()
    } catch (error) {
      if (get().status === 'ready') return
      updateRuntime({
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
    if (emoji) updateRuntime({ emoji })
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
    commands.setView(VIEWS[(index + delta + VIEWS.length) % VIEWS.length] ?? 'important')
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

  openConversation: (id) => {
    const state = get()
    const item = state.channels[id] ?? state.directMessages[id]
    if (!item) return
    const through = state.done[id]
    const view = state.inboxMuted[id] || through !== undefined && compareTs(item.latestTs, through) <= 0 ? 'done' : 'inbox'
    set({ ...selectionPatch(id), view, mode: 'reading', checked: {}, searchOpen: false })
  },

  setSearchOpen: (searchOpen) => set({ searchOpen, helpOpen: false }),

  escape: () => {
    const state = get()
    if (state.helpOpen) set({ helpOpen: false })
    else if (state.focusedThread || state.threadTarget) set({ focusedThread: undefined, threadTarget: undefined })
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

  toggleMessageSaved: async (channel, message) => {
    const id = `${channel}:${message.ts}`
    const saved = laterCollection.get(id)
    try {
      if (saved) {
        await localApi.removeLater(channel, message.ts)
        setLaterOverrides([[id, undefined]])
        showToast('Removed message from Later', {
          undo: () => run(localApi.saveForLater(channel, message.ts).then(() => setLaterOverrides([[id, saved]]))),
        })
        return
      }
      const state = get()
      const conversation = state.channels[channel]?.conversation ?? state.directMessages[channel]?.conversation ?? currentItem(state)?.conversation
      if (!conversation || conversation.id !== channel) return
      const item: LaterItem = { id, conversation, messages: [message], ts: message.ts, savedAt: Date.now() }
      const { created } = await localApi.saveForLater(channel, message.ts)
      setLaterOverrides([[id, item]])
      showToast('Saved message for later', {
        undo: created ? () => {
          run(localApi.removeLater(channel, message.ts).then(() => setLaterOverrides([[id, undefined]])))
        } : undefined,
      })
    } catch (error) {
      reportError(error)
    }
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

  toggleInboxMute: (item) => {
    const channel = item.conversation.id
    const muted = !get().inboxMuted[channel]
    run((async () => {
      await localApi.setInboxMuted(channel, muted)
      if (muted && !get().done[channel]) setDone(channel, latestTs(item))
      await commands.load()
      if (get().view === 'inbox' && muted) set(selectionPatch(computeVisible(get())[0]?.id))
      showToast(muted ? 'Muted thread' : 'Unmuted thread')
    })())
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
      for (const [key, classification] of entries) pendingUpdates.classificationOverrides[key] = override(classification)
      const lookup = (key: string) => pendingUpdates.classificationOverrides[key]?.value
      const items = targets.flatMap((item) => {
        const existing = inboxCollection.get(item.id)
        return existing ? [withClassification(existing, lookup)] : []
      })
      reconcile(inboxCollection, items, false)
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
    set((state) => ({ threadTarget: undefined, composerFocusRequest: state.composerFocusRequest + 1, composerFocusChannel: currentItem(get())?.conversation.id }))
  },

  replyInThread: (ts) => {
    const state = get()
    const item = currentItem(state)
    if (!item) return
    const targetTs = ts ?? latestTs(item)
    const message = findMessage(item, targetTs)
    set({
      threadTarget: message?.thread_ts ?? targetTs,
      focusedThread: { channel: item.conversation.id, ts: message?.thread_ts ?? targetTs },
      composerFocusRequest: state.composerFocusRequest + 1,
      composerFocusChannel: item.conversation.id,
    })
  },

  clearThreadTarget: () => set({ threadTarget: undefined }),

  send: async (message, item, threadTs) => {
    const state = get()
    const result = await localApi.postMessage(item.conversation.id, message, threadTs)
    if (get().selectedId === item.id && get().threadTarget === state.threadTarget) set({ threadTarget: undefined })
    if (isConversationView(state.view)) {
      run(localApi.markRead(item.conversation.id, maxTs(latestTs(item), result.ts ?? '0')).then(() => commands.load()))
    } else {
      commands.markDone([item.id], 'Reply sent')
    }
  },

  toggleThread: (ts) => {
    const state = get()
    const item = currentItem(state)
    if (!item) return
    const targetTs = ts ?? latestTs(item)
    if (!targetTs) return
    const message = findMessage(item, targetTs)
    if (!message?.reply_count) return
    const rootTs = message.thread_ts ?? targetTs
    const focused = state.focusedThread
    set({
      focusedThread: focused?.channel === item.conversation.id && focused.ts === rootTs ? undefined : { channel: item.conversation.id, ts: rootTs },
      threadTarget: undefined,
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
