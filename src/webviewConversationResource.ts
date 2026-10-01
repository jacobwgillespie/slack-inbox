import type { WebviewConversation } from './slack/webview'

export interface ImagePreview { source: string; width: number; height: number }
const previews = new Map<string, ImagePreview>()
const imageLoads = new Map<string, Promise<ImagePreview>>()

export function cachedImagePreview(source: string) { return previews.get(source) }

export function loadImagePreview(source: string): Promise<ImagePreview> {
  const cached = previews.get(source)
  if (cached) return Promise.resolve(cached)
  const pending = imageLoads.get(source)
  if (pending) return pending
  const promise = (async () => {
    const data = await window.slackDesktop!.readImage(source)
    const image = new Image()
    image.src = data
    await image.decode()
    const preview = { source: data, width: image.naturalWidth, height: image.naturalHeight }
    if (previews.size >= 40) previews.delete(previews.keys().next().value!)
    previews.set(source, preview)
    return preview
  })().finally(() => imageLoads.delete(source))
  imageLoads.set(source, promise)
  return promise
}

type InitialConversation = { snapshot?: WebviewConversation; error?: string }
const conversations = new Map<string, Promise<InitialConversation>>()

export function initialConversation(channel: string): Promise<InitialConversation> {
  const cached = conversations.get(channel)
  if (cached) {
    conversations.delete(channel)
    conversations.set(channel, cached)
    return cached
  }
  const promise = (async (): Promise<InitialConversation> => {
    try {
      const bridge = window.slackDesktop!
      const snapshot = await new Promise<WebviewConversation>((resolve, reject) => {
        let busy = false
        let dirty = false
        let finished = false
        const finish = (value?: WebviewConversation, cause?: unknown) => {
          if (finished) return
          finished = true
          clearTimeout(timeout)
          unsubscribe()
          if (cause) reject(cause)
          else resolve(value!)
        }
        const read = async () => {
          if (finished) return
          if (busy) { dirty = true; return }
          busy = true
          try {
            const next = await bridge.readConversation(channel)
            if (next.ready) finish(next)
          } catch (cause) { finish(undefined, cause) }
          finally {
            busy = false
            if (dirty && !finished) { dirty = false; void read() }
          }
        }
        const unsubscribe = bridge.onConversationChange((changed) => {
          if (changed === channel) void read()
          else finish(undefined, new Error('Conversation changed.'))
        })
        const timeout = setTimeout(() => finish(undefined, new Error('Slack has not rendered this conversation yet.')), 15000)
        void bridge.openConversation(channel).then(read).catch((cause) => finish(undefined, cause))
      })
      // A failed preview should not prevent opening the conversation.
      await Promise.allSettled(snapshot.messages.flatMap((message) => (message.images ?? []).map(async (image) => {
        const preview = await loadImagePreview(image.src)
        image.width = preview.width
        image.height = preview.height
      })))
      return { snapshot }
    } catch (cause) {
      if (cause instanceof Error && /Conversation (is no longer active|changed)/.test(cause.message)) conversations.delete(channel)
      return { error: cause instanceof Error ? cause.message : 'Could not open Slack.' }
    }
  })()
  if (conversations.size >= 8) conversations.delete(conversations.keys().next().value!)
  conversations.set(channel, promise)
  return promise
}

export function retryInitialConversation(channel: string) { conversations.delete(channel) }
