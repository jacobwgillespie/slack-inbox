import { readComposerSelection, restoreComposerSelection, type ComposerAction } from '../src/slack/composer'
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

// Copy DOM from the manual view; the collector never owns an editor.
if (!process.argv.includes('--slack-background-collector')) {
  let binding: { channel: string; generation: number } | undefined
  let lastHtml: string | undefined
  let composerRoot: HTMLElement | undefined
  let scheduled = false
  let source: 'slack' | 'inbox' = 'slack'
  let actionType: ComposerAction['type'] | undefined
  const targets = new Map<string, HTMLElement>()
  const ids = new WeakMap<HTMLElement, string>()
  let nextId = 0
  const targetId = (element: HTMLElement) => {
    let id = ids.get(element)
    if (!id) { id = String(++nextId); ids.set(element, id) }
    targets.set(id, element)
    return id
  }
  const copyImage = (element: HTMLElement, copy: HTMLElement) => {
    if (element instanceof HTMLImageElement) {
      copy.setAttribute('src', element.currentSrc || element.src)
      copy.removeAttribute('srcset')
    }
  }
  const findEditor = () => [...document.querySelectorAll<HTMLElement>('.ql-editor[contenteditable="true"]')]
    .find((element) => !element.closest('.p-thread_view') && element.closest('[data-channel-id]')?.getAttribute('data-channel-id') === binding?.channel)
  const ready = () => binding && location.origin === 'https://app.slack.com' && location.pathname.split('/')[3] === binding.channel
  const sync = () => {
    scheduled = false
    if (!ready()) return
    const editor = findEditor()
    if (!editor || !binding) return
    // Find the smallest editor ancestor that also includes Slack's controls.
    let root = editor.parentElement ?? editor
    for (let depth = 0; depth < 6 && !root.querySelector('button'); depth++) {
      if (!root.parentElement || root.parentElement === document.body) break
      root = root.parentElement
    }
    composerRoot = root
    const clone = root.cloneNode(true) as HTMLElement
    targets.clear()
    const originals = [root, ...root.querySelectorAll<HTMLElement>('*')]
    const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
    originals.forEach((element, index) => {
      const copy = copies[index]!
      copyImage(element, copy)
      if (element === editor) {
        copy.dataset.slackEditor = 'true'
        copy.setAttribute('contenteditable', 'true')
      }
      if (element.matches('button, [role="button"], [role="option"], [role="menuitem"]')) {
        const id = targetId(element)
        copy.dataset.slackAction = id
        if (copy.tagName === 'BUTTON') copy.setAttribute('type', 'button')
      }
      // Preserve layout and icons without importing Slack's global stylesheet.
      const computed = getComputedStyle(element)
      for (const property of ['display', 'flex-direction', 'align-items', 'justify-content', 'gap', 'padding', 'margin', 'width', 'height']) {
        if (element === editor || element.contains(editor) || property === 'width' || property === 'height') continue
        copy.style.setProperty(property, computed.getPropertyValue(property))
      }
      if (copy.localName === 'svg') {
        copy.style.width = '20px'
        copy.style.height = '20px'
      }
      copy.removeAttribute('id')
      // The copied document must not autofocus or submit a local form.
      copy.removeAttribute('autofocus')
    })
    const placeholder = clone.querySelector('.c-texty_input__placeholder')
    const copiedEditor = clone.querySelector<HTMLElement>('[data-slack-editor]')
    if (placeholder && copiedEditor) {
      copiedEditor.dataset.placeholder = placeholder.textContent ?? ''
      placeholder.remove()
    }
    // Slack's autocomplete is rendered outside the composer, in a portal.
    const portals = [...document.querySelectorAll<HTMLElement>('[role="listbox"], [role="menu"], [role="dialog"]')]
      .filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' &&
        !root.contains(element) && !element.parentElement?.closest('[role="listbox"], [role="menu"], [role="dialog"]'))
    for (const portal of portals) {
      const popup = portal.cloneNode(true) as HTMLElement
      popup.removeAttribute('style')
      popup.dataset.slackSuggestions = 'true'
      const originals = [portal, ...portal.querySelectorAll<HTMLElement>('*')]
      const copies = [popup, ...popup.querySelectorAll<HTMLElement>('*')]
      originals.forEach((element, index) => {
        const copy = copies[index]!
        copyImage(element, copy)
        copy.removeAttribute('id')
        if (element.matches('button, [role="button"], [role="option"], [role="menuitem"]')) {
          copy.dataset.slackAction = targetId(element)
          if (copy.tagName === 'BUTTON') copy.setAttribute('type', 'button')
        }
        if (copy.localName === 'svg') { copy.style.width = '20px'; copy.style.height = '20px' }
      })
      clone.append(popup)
    }
    const html = clone.outerHTML
    if (html !== lastHtml || source === 'inbox') {
      lastHtml = html
      ipcRenderer.send('slack:composer-changed', {
        channel: binding.channel, generation: binding.generation, html,
        selection: readComposerSelection(editor), action: actionType, source,
      })
    }
    source = 'slack'
    actionType = undefined
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(sync)
  }
  ipcRenderer.on('slack:composer-bind', (_event, next: typeof binding) => {
    binding = next
    lastHtml = undefined
    schedule()
  })
  ipcRenderer.on('slack:composer-action', (_event, generation: number, action: ComposerAction) => {
    if (!ready() || binding?.generation !== generation) return
    const editor = findEditor()
    if (!editor) return
    source = 'inbox'
    actionType = action.type
    editor.focus({ preventScroll: true })
    if (action.type === 'input') {
      if (editor.innerHTML !== action.html) {
        const range = document.createRange()
        range.selectNodeContents(editor)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        document.execCommand('insertHTML', false, action.html || '<p><br></p>')
      }
      restoreComposerSelection(editor, action.selection)
    } else {
      restoreComposerSelection(editor, action.selection)
      if (action.type === 'click') targets.get(action.id)?.click()
      else {
        const codes: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, ArrowUp: 38, ArrowDown: 40 }
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, code: action.key, keyCode: codes[action.key], which: codes[action.key], bubbles: true, cancelable: true }))
      }
    }
    schedule()
  })
  window.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((records) => {
      const relevant = (node: Node) => {
        const element = node instanceof Element ? node : node.parentElement
        return composerRoot?.contains(node) || element?.closest('[role="listbox"], [role="menu"], [role="dialog"]') ||
          element?.querySelector('.ql-editor, [role="listbox"], [role="menu"], [role="dialog"]')
      }
      if (!composerRoot?.isConnected || records.some((record) => relevant(record.target) || [...record.addedNodes, ...record.removedNodes].some(relevant))) schedule()
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-expanded', 'aria-selected', 'class', 'data-channel-id'] })
    document.addEventListener('input', schedule)
    schedule()
  })
}
