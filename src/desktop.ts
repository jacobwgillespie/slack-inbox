import type { WebviewConversation } from './slack/webview'

declare global {
  interface Window {
    slackDesktop?: {
      platform: string
      openConversation(channel: string): Promise<void>
      readConversation(channel: string, direction?: 'older' | 'latest'): Promise<WebviewConversation>
      onConversationChange(callback: (channel: string) => void): () => void
      readImage(source: string): Promise<string>
      showSlack(channel?: string): Promise<void>
      signInWithBrowser(): Promise<void>
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
