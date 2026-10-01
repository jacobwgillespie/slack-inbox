import { contextBridge, ipcRenderer } from 'electron'

// Both embedded views start in the background. Only the manual Slack view
// receives permission to write read markers when the user reveals it.
contextBridge.executeInMainWorld({ func: () => {
  const state = window as typeof window & { __inboxReadMarkers?: boolean }
  state.__inboxReadMarkers = false
  const original = WebSocket.prototype.send
  WebSocket.prototype.send = function(data) {
    try {
      const message = typeof data === 'string' ? JSON.parse(data) : undefined
      if (!state.__inboxReadMarkers && (['im_mark', 'mpim_mark', 'channel_mark', 'group_mark'].includes(message?.type) ||
        ['conversations.mark', 'im.mark', 'mpim.mark', 'channels.mark', 'groups.mark'].includes(message?.method))) return
    } catch { /* Non-JSON socket frame. */ }
    return original.call(this, data)
  }
} })
ipcRenderer.on('slack:read-markers-enabled', (_event, enabled: boolean) => {
  if (process.argv.includes('--slack-background-collector')) return
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

// The manual view owns drafts. The collector never edits a composer.
if (!process.argv.includes('--slack-background-collector')) {
  let binding: { channel: string; generation: number; text?: string } | undefined
  let editor: HTMLElement | null = null
  let lastText: string | undefined
  let applying = false
  let scheduled = false
  const readText = (element: HTMLElement) => element.innerText.replace(/\n$/, '')
  const sync = () => {
    scheduled = false
    if (!binding || location.origin !== 'https://app.slack.com' || location.pathname.split('/')[3] !== binding.channel) return
    const next = [...document.querySelectorAll<HTMLElement>('.ql-editor[contenteditable="true"]')]
      .find((element) => !element.closest('.p-thread_view'))
    if (!next) return
    if (next !== editor) { editor = next; lastText = undefined }
    const source = binding.text === undefined ? 'slack' : 'inbox'
    if (binding.text !== undefined && readText(editor) !== binding.text) {
      applying = true
      // Native editing commands notify Quill and preserve Slack's draft handling.
      // Setting innerHTML alone would only change the DOM, not its editor state.
      editor.focus({ preventScroll: true })
      const range = document.createRange()
      range.selectNodeContents(editor)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      if (binding.text) document.execCommand('insertText', false, binding.text)
      else document.execCommand('delete')
      applying = false
    }
    binding.text = undefined
    const text = readText(editor)
    if (text === lastText) return
    lastText = text
    ipcRenderer.send('slack:composer-changed', { channel: binding.channel, generation: binding.generation, text, source })
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(sync)
  }
  ipcRenderer.on('slack:composer-bind', (_event, next: typeof binding) => {
    if (next?.generation !== binding?.generation) { editor = null; lastText = undefined }
    binding = next
    schedule()
  })
  window.addEventListener('DOMContentLoaded', () => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true })
    document.addEventListener('input', (event) => {
      if (!applying && event.target instanceof Element && event.target.closest('.ql-editor')) schedule()
    })
    schedule()
  })
}
