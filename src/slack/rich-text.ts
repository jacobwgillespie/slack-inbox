import type { JSONContent } from '@tiptap/core'
import type { SlackFile } from './types'

export interface RichTextElement {
  type: string
  text?: string
  url?: string
  user_id?: string
  name?: string
  range?: string
  skin_tone?: number
  style?: Record<string, boolean> | 'bullet' | 'ordered'
  elements?: RichTextElement[]
  indent?: number
  offset?: number
}
export interface RichTextBlock {
  type: 'rich_text'
  elements: RichTextElement[]
}
export interface OutgoingMessage {
  text: string
  blocks?: RichTextBlock[]
  gif?: { url: string; title: string }
  files?: SlackFile[]
  clientMsgId: string
}

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// Image captions must remain rich-text blocks when editing a rich-text message.
export function mrkdwnElements(text: string, style: Record<string, boolean> = {}): RichTextElement[] {
  const decode = (value: string) => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  const pattern = /<([^<>]+)>|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~|:([a-z0-9_+'-]+)(?:::skin-tone-([2-6]))?:/gi
  const elements: RichTextElement[] = []
  let offset = 0
  const literal = (value: string) => { if (value) elements.push({ type: 'text', text: decode(value), style }) }
  for (const match of text.matchAll(pattern)) {
    literal(text.slice(offset, match.index))
    const [, angle, code, bold, italic, strike, emoji, tone] = match
    if (angle) {
      const [target = '', label] = angle.split('|')
      if (target.startsWith('@')) elements.push({ type: 'user', user_id: target.slice(1), style })
      else if (/^https?:|^mailto:/i.test(target)) elements.push({ type: 'link', url: decode(target), text: decode(label ?? target), style })
      else if (['!here', '!channel', '!everyone'].includes(target)) elements.push({ type: 'broadcast', range: target.slice(1), style })
      else literal(match[0])
    } else if (code) elements.push({ type: 'text', text: decode(code), style: { ...style, code: true } })
    else if (bold || italic || strike) elements.push(...mrkdwnElements((bold ?? italic ?? strike)!, { ...style, [bold ? 'bold' : italic ? 'italic' : 'strike']: true }))
    else if (emoji) elements.push({ type: 'emoji', name: emoji, ...(tone ? { skin_tone: Number(tone) } : {}) })
    offset = match.index + match[0].length
  }
  literal(text.slice(offset))
  return elements
}

function inline(nodes: JSONContent[] = []): RichTextElement[] {
  return nodes.flatMap((node): RichTextElement[] => {
    if (node.type === 'hardBreak') return [{ type: 'text', text: '\n' }]
    if (node.type === 'mention') return ['here', 'channel', 'everyone'].includes(node.attrs!.id)
      ? [{ type: 'broadcast', range: node.attrs!.id }]
      : [{ type: 'user', user_id: node.attrs!.id }]
    if (node.type === 'emoji') {
      const [name, tone] = String(node.attrs!.name).split('::skin-tone-')
      return [{ type: 'emoji', name, ...(tone ? { skin_tone: Number(tone) } : {}) }]
    }
    if (!node.text) return []
    const style: Record<string, boolean> = {}
    for (const mark of node.marks ?? []) {
      const key = { bold: 'bold', italic: 'italic', strike: 'strike', code: 'code' }[mark.type]
      if (key) style[key] = true
    }
    const link = node.marks?.find((mark) => mark.type === 'link')
    return [{ type: link ? 'link' : 'text', text: node.text, ...(link ? { url: link.attrs!.href } : {}), ...(Object.keys(style).length ? { style } : {}) }]
  })
}

function sections(nodes: JSONContent[] = [], indent = 0): RichTextElement[] {
  return nodes.flatMap((node): RichTextElement[] => {
    if (node.type === 'bulletList' || node.type === 'orderedList') {
      const result: RichTextElement[] = []
      for (const [index, item] of (node.content ?? []).entries()) {
        const paragraphs = (item.content ?? []).filter((child) => child.type === 'paragraph')
        result.push({ type: 'rich_text_list', style: node.type === 'bulletList' ? 'bullet' : 'ordered', indent,
          ...(node.type === 'orderedList' ? { offset: Number(node.attrs?.start ?? 1) - 1 + index } : {}),
          elements: [{ type: 'rich_text_section', elements: paragraphs.flatMap((p, i) => [...(i ? [{ type: 'text', text: '\n' }] : []), ...inline(p.content)]) }],
        })
        result.push(...sections((item.content ?? []).filter((child) => child.type !== 'paragraph'), indent + 1))
      }
      return result
    }
    if (node.type === 'blockquote') {
      return [{ type: 'rich_text_quote', elements: inlineTextBlocks(node.content) }]
    }
    if (node.type === 'codeBlock') {
      return [{ type: 'rich_text_preformatted', elements: [{ type: 'text', text: (node.content ?? []).map((child) => child.text ?? '').join('') }] }]
    }
    return [{ type: 'rich_text_section', elements: inline(node.content).length ? inline(node.content) : [{ type: 'text', text: '\n' }] }]
  })
}

function inlineTextBlocks(nodes: JSONContent[] = []): RichTextElement[] {
  return nodes.flatMap((node, i) => [...(i ? [{ type: 'text', text: '\n' }] : []), ...inline(node.content)])
}

function fallback(node: JSONContent): string {
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'mention') return ['here', 'channel', 'everyone'].includes(node.attrs!.id) ? `<!${node.attrs!.id}>` : `<@${node.attrs!.id}>`
  if (node.type === 'emoji') return `:${node.attrs!.name}:`
  if (node.text) {
    let text = escape(node.text)
    for (const mark of node.marks ?? []) {
      const delimiter = { bold: '*', italic: '_', strike: '~', code: '`' }[mark.type]
      if (delimiter) text = `${delimiter}${text}${delimiter}`
      if (mark.type === 'link') text = `<${escape(mark.attrs!.href)}|${text}>`
    }
    return text
  }
  if (node.type === 'orderedList') return (node.content ?? []).map((item, i) => `${Number(node.attrs?.start ?? 1) + i}. ${(item.content ?? []).map(fallback).join('\n')}`).join('\n')
  const separator = ['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(node.type ?? '') ? '\n' : ''
  const text = (node.content ?? []).map(fallback).join(separator)
  if (node.type === 'codeBlock') return `\`\`\`${text}\`\`\``
  if (node.type === 'blockquote') return text.split('\n').map((line) => `> ${line}`).join('\n')
  if (node.type === 'listItem') return `• ${text}`
  return text
}

export function serializeMessage(document: JSONContent): Pick<OutgoingMessage, 'text' | 'blocks'> {
  const text = fallback(document)
  return { text, blocks: text.trim() ? [{ type: 'rich_text', elements: sections(document.content) }] : undefined }
}
