import type { CachedConversation } from './slack/dm-cache'

declare global {
  interface Window {
    slackDesktop: {
      platform: string
      updateVersion(): Promise<string | undefined>
      installUpdate(): Promise<void>
      onUpdateReady(callback: (version: string) => void): () => void
      sendTyping(channel: string): Promise<boolean>
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
  window.dispatchEvent(new Event('desktop-slack-open'))
  void window.slackDesktop.showSlack(channel).catch(() => {
    window.dispatchEvent(new Event('desktop-slack-close'))
  })
}
