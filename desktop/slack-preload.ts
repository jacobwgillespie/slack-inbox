import { contextBridge, ipcRenderer } from 'electron'

// Background collection cannot write read markers; revealing Slack enables them.
contextBridge.executeInMainWorld({ func: () => {
  const state = window as typeof window & { __inboxReadMarkers?: boolean; __inboxTypingSocket?: WebSocket }
  state.__inboxReadMarkers = false
  const original = WebSocket.prototype.send
  WebSocket.prototype.send = function(data) {
    const url = new URL(this.url)
    if (url.protocol === 'wss:' && url.hostname.endsWith('.slack.com')) state.__inboxTypingSocket = this
    try {
      const message = typeof data === 'string' ? JSON.parse(data) : undefined
      if (!state.__inboxReadMarkers && (['im_mark', 'mpim_mark', 'channel_mark', 'group_mark'].includes(message?.type) ||
        ['conversations.mark', 'im.mark', 'mpim.mark', 'channels.mark', 'groups.mark'].includes(message?.method))) return
    } catch { /* Non-JSON socket frame. */ }
    return original.call(this, data)
  }
} })
ipcRenderer.on('slack:read-markers-enabled', (_event, enabled: boolean) => {
  contextBridge.executeInMainWorld({ func: (enabled: boolean) => {
    (window as typeof window & { __inboxReadMarkers?: boolean }).__inboxReadMarkers = enabled
  }, args: [enabled] })
})

// Slack gets no exposed bridge; only the preload can report changes over IPC.
window.addEventListener('DOMContentLoaded', () => {
  if (location.origin !== 'https://app.slack.com') return
  // Embedded Slack sits behind our UI; its drag regions must not intercept clicks.
  const style = document.createElement('style')
  style.textContent = '* { -webkit-app-region: no-drag !important; }'
  document.head.append(style)
  let scheduled = false
  const notify = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const channel = location.pathname.split('/')[3]
      if (channel) ipcRenderer.send('slack:timeline-changed', channel)
    })
  }
  const inTimeline = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement
    return Boolean(element?.closest('.p-message_pane') || element?.querySelector('.p-message_pane'))
  }
  new MutationObserver((records) => {
    if (!document.querySelector('.p-message_pane') || records.some((record) => inTimeline(record.target) || [...record.addedNodes, ...record.removedNodes].some(inTimeline))) notify()
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'data-item-key', 'data-msg-channel-id', 'data-message-sender'] })
  window.addEventListener('popstate', notify)
  notify()
})
