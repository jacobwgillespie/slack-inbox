import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type View = 'important' | 'other' | 'later' | 'muted' | 'inbox' | 'done'
export const isConversationView = (view: View) => view === 'inbox' || view === 'done'
export const VIEWS: View[] = ['inbox', 'later', 'done']

type Mode = 'list' | 'reading'

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'error'
  undo?: () => void
}

export interface InboxState {
  view: View
  mode: Mode
  selectedId?: string
  checked: Record<string, true>
  threadTarget?: string
  focusedThread?: { channel: string; ts: string }
  toast?: Toast
  helpOpen: boolean
  searchOpen: boolean
  composerFocusRequest: number
  composerFocusChannel?: string
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

export const inboxStore = create<InboxState>()(
  persist<InboxState, [], [], Pick<InboxState, 'view'>>(() => ({
    view: 'inbox',
    mode: 'list',
    checked: {},
    helpOpen: false,
    searchOpen: false,
    composerFocusRequest: 0,
  }), {
    name: 'slack-inbox',
    version: 4,
    storage: createJSONStorage(() => resilientLocalStorage),
    migrate: (persisted) => {
      const view = (persisted as { view?: View } | undefined)?.view
      return { view: view && VIEWS.includes(view) ? view : 'inbox' }
    },
    partialize: (state) => ({ view: state.view }),
  }),
)

export const useStore = inboxStore
