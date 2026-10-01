import { ipcRenderer } from 'electron'

// Slack gets no exposed bridge; this preload only reports timeline changes.
window.addEventListener('DOMContentLoaded', () => {
  if (location.origin !== 'https://app.slack.com') return
  let scheduled = false
  const notify = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const channel = location.pathname.split('/')[3]
      if (channel && document.querySelector('.p-message_pane')) ipcRenderer.send('slack:timeline-changed', channel)
    })
  }
  const inTimeline = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement
    return Boolean(element?.closest('.p-message_pane') || element?.querySelector('.p-message_pane'))
  }
  new MutationObserver((records) => {
    if (records.some((record) => inTimeline(record.target) || [...record.addedNodes, ...record.removedNodes].some(inTimeline))) notify()
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'data-item-key', 'data-msg-channel-id', 'data-message-sender'] })
  window.addEventListener('popstate', notify)
  notify()
})
