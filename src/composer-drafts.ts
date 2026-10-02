import type { JSONContent } from '@tiptap/core'
import type { Gif } from './gifs'
import { create } from 'zustand'
import type { DraftImage } from './composer-images'

export interface ComposerDraft {
  document: JSONContent
  gif?: Gif
  images?: DraftImage[]
  clientMsgId: string
}

export function readDraft(key: string): ComposerDraft | undefined {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined } catch { return undefined }
}

export function saveDraft(key: string, draft: ComposerDraft) {
  localStorage.setItem(key, JSON.stringify(draft))
}

export function clearSentDraft(key: string, clientMsgId: string) {
  if (readDraft(key)?.clientMsgId === clientMsgId) localStorage.removeItem(key)
}

// Requests can outlive the mounted conversation. Keep its pending state across navigation.
export const useDraftSending = create<{ pending: Record<string, boolean>; sent: Record<string, string>; markSent: (key: string, clientMsgId: string) => void; setPending: (key: string, pending: boolean) => void }>((set) => ({
  pending: {},
  sent: {},
  markSent: (key, clientMsgId) => set((state) => ({ sent: { ...state.sent, [key]: clientMsgId } })),
  setPending: (key, pending) => set((state) => {
    const next = { ...state.pending }
    if (pending) next[key] = true
    else delete next[key]
    return { pending: next }
  }),
}))
