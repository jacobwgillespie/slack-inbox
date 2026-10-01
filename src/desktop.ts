import type { CachedConversation } from './slack/dm-cache'

declare global {
  interface Window {
    slackDesktop?: {
      platform: string
      followComposer(channel: string, text?: string): Promise<number | undefined>
      stopComposer(generation: number): Promise<void>
      writeComposer(generation: number, text: string): Promise<void>
      onComposerChange(callback: (draft: { channel: string; generation: number; text: string; source: 'slack' | 'inbox' }) => void): () => void
      readCache(channel?: string, options?: { before?: string; after?: string }): Promise<CachedConversation[]>
      watchConversations(channels: string[], selected?: string): Promise<void>
      refreshConversation(channel: string, older?: boolean): Promise<void>
      onCacheChange(callback: (channel?: string) => void): () => void
      readImage(source: string): Promise<string>
      showSlack(channel?: string): Promise<void>
      signInWithBrowser(): Promise<void>
      logOut(): Promise<void>
      hideSlack(): Promise<void>
    }
  }
}

export function openDesktopSlack(channel?: string) {
  if (!window.slackDesktop) return false
  window.dispatchEvent(new Event('desktop-slack-open'))
  void window.slackDesktop.showSlack(channel).catch(() => {
    window.dispatchEvent(new Event('desktop-slack-close'))
  })
  return true
}
