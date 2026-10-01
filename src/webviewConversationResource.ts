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
      await bridge.openConversation(channel)
      const deadline = Date.now() + 15000
      let snapshot: WebviewConversation
      let signature = ''
      let stableReads = 0
      do {
        snapshot = await bridge.readConversation(channel)
        if (snapshot.ready) {
          const next = JSON.stringify(snapshot)
          stableReads = next === signature ? stableReads + 1 : 0
          signature = next
          if (stableReads >= 2) break
        }
        if (Date.now() > deadline) {
          if (snapshot.ready) break
          throw new Error('Slack has not rendered this conversation yet.')
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      } while (true)
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
