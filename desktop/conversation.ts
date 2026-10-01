import type { WebContents } from 'electron'
import type { WebviewConversation } from '../src/slack/webview.ts'

// This function runs in Slack's page. Read only its rendered timeline, not its
// private React store or our API/database. Slack virtualizes this list.
function readTimeline(): WebviewConversation {
  const channel = location.pathname.split('/')[3] ?? ''
  const pane = document.querySelector('.p-message_pane')
  if (!pane) return { channel, messages: [], ready: false, hasMore: false }
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let emoji: Record<string, string> = {}
  const emojiName = (image: HTMLElement) => {
    const label = image.getAttribute('data-stringify-emoji') ?? image.getAttribute('alt') ?? ''
    return label.replace(/^:|:$/g, '')
  }
  const captureEmoji = (image: HTMLImageElement, name: string) => {
    if (name && image.src.startsWith('https://')) emoji[name] = image.src
  }
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escape(node.textContent ?? '')
    if (!(node instanceof HTMLElement)) return ''
    if (node.tagName === 'BR') return '\n'
    if (node instanceof HTMLImageElement) {
      const name = emojiName(node)
      captureEmoji(node, name)
      return /^[a-z0-9_+'-]+(?:::skin-tone-[2-6]){0,2}$/i.test(name) ? `:${name}:` : escape(node.alt)
    }
    const content = [...node.childNodes].map(text).join('')
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? ''
      return /^https?:\/\//.test(href) ? `<${href.replace(/[<>|]/g, '')}|${content}>` : content
    }
    if (node.tagName === 'STRONG' || node.tagName === 'B') return `*${content}*`
    if (node.tagName === 'EM' || node.tagName === 'I') return `_${content}_`
    if (node.tagName === 'CODE') return '`' + content + '`'
    if (node.tagName === 'LI') {
      const prefix = node.parentElement?.tagName === 'OL' ? `${[...node.parentElement.children].indexOf(node) + 1}. ` : '• '
      return prefix + content.trim() + '\n'
    }
    if (node.tagName === 'P' || node.tagName === 'DIV') return content + '\n'
    return content
  }
  let author: string | undefined
  let name: string | undefined
  const messages: WebviewConversation['messages'] = []
  for (const row of pane.querySelectorAll<HTMLElement>('.c-virtual_list__item')) {
    emoji = {}
    const ts = row.dataset.itemKey ?? row.querySelector<HTMLElement>('[data-ts]')?.dataset.ts
    if (!ts || !/^\d+\.\d+$/.test(ts)) continue
    if (row.querySelector<HTMLElement>('[data-msg-channel-id]')?.dataset.msgChannelId !== channel) continue
    const sender = row.querySelector<HTMLElement>('[data-message-sender]') ?? row.querySelector<HTMLElement>('.c-message__sender, .c-message_kit__sender')
    const senderId = sender?.dataset.messageSender ?? sender?.dataset.memberId
    if (sender) { author = senderId; name = sender.innerText.trim() }
    const body = row.querySelector<HTMLElement>('[data-qa="message-text"], .c-message_kit__text, .c-message__body')
    const images = [...row.querySelectorAll<HTMLImageElement>('.c-file__thumb img, .c-file__image img, .c-image_block img')]
      .filter((image) => image.src.startsWith('https://'))
      .map((image) => ({ src: image.src, alt: image.alt || 'Image attachment', width: image.naturalWidth || undefined, height: image.naturalHeight || undefined }))
    const attachments: NonNullable<WebviewConversation['messages'][number]['attachments']> = []
    // Collapsed Slack attachments expose a file link rather than a thumbnail.
    for (const link of row.querySelectorAll<HTMLAnchorElement>('a[href*="/files-pri/"]')) {
      if (/\.(png|jpe?g|gif|webp|avif)(?:\?|$)/i.test(link.href) && !images.some((image) => image.src === link.href)) {
        images.push({ src: link.href, alt: link.getAttribute('aria-label') || link.innerText.trim() || 'Image attachment', width: undefined, height: undefined })
      } else if (!images.some((image) => image.src === link.href)) {
        attachments.push({ title: link.getAttribute('aria-label') || link.innerText.trim() || 'File attachment', title_link: link.href })
      }
    }
    const reactions = [...row.querySelectorAll<HTMLElement>('.c-reaction')].map((reaction) => {
      const image = reaction.querySelector('img')
      const name = image ? emojiName(image) : reaction.querySelector('[data-stringify-emoji]')?.getAttribute('data-stringify-emoji')?.replace(/^:|:$/g, '') ?? 'emoji'
      if (image) captureEmoji(image, name)
      return { name, count: Number(reaction.querySelector('.c-reaction__count')?.textContent) || 1 }
    })
    if (body || images.length || attachments.length) messages.push({ ts, text: body ? text(body).trim() : '', user: author, username: name, images, reactions, attachments, emoji })
  }
  const beginning = Boolean(pane.querySelector('.c-message_list__day_divider__label--start, .c-message_list__channel_intro'))
  return { channel, messages, ready: messages.length > 0 || beginning, hasMore: !beginning }
}

export async function readConversation(contents: WebContents): Promise<WebviewConversation> {
  if (!contents.getURL().startsWith('https://app.slack.com/client/')) throw new Error('Slack is not signed in.')
  return contents.executeJavaScript(`(${readTimeline.toString()})()`)
}

export async function scrollConversation(contents: WebContents, direction: 'older' | 'latest') {
  await contents.executeJavaScript(`(() => {
    const pane = document.querySelector('.p-message_pane');
    const list = pane?.querySelector('.c-scrollbar__hider');
    if (!list) throw new Error('Slack message list is not ready.');
    list.scrollTop = ${direction === 'older' ? 'Math.max(0, list.scrollTop - list.clientHeight * 0.8)' : 'list.scrollHeight'};
  })()`)
}
