import { findMessage, threadTargetFor } from '../selectors'
import { useRuntime } from '../data'
import { commands } from '../commands'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Extension, Node, mergeAttributes } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Mention from '@tiptap/extension-mention'
import Placeholder from '@tiptap/extension-placeholder'
import Suggestion from '@tiptap/suggestion'
import { authorName, conversationLabel } from '../format'
import { useFormatContext } from '../hooks'
import { useStore } from '../store'
import { readDraft, saveDraft, clearSentDraft, useDraftSending } from '../composer-drafts'
import { serializeMessage } from '../slack/rich-text'
import emojiData from '../slack/emoji-data.json'
import type { InboxItem } from '../slack/types'
import { ArrowUpIcon } from './Icons'
import { GIF_COMMAND, suggestionMenu, type ComposerSuggestion } from './composer-suggestions'
import { GifPicker } from './GifPicker'

const standardEmoji: Record<string, string> = emojiData

function emojiAppearance(name: string, custom: Record<string, string>, depth = 0): { image?: string; glyph?: string } {
  const value = custom[name]
  if (value?.startsWith('alias:')) return depth < 10 ? emojiAppearance(value.slice(6), custom, depth + 1) : {}
  return value ? { image: value } : { glyph: standardEmoji[name] }
}

export function Composer({ item, autoFocus = false }: { item: InboxItem; autoFocus?: boolean }) {
  const session = useRuntime().session
  const threadTarget = useStore((state) => state.threadTarget)
  const thread = threadTargetFor(item, threadTarget)
  const draftKey = `composer:${session?.teamId}:${session?.userId}:${item.conversation.id}:${thread ?? ''}`
  return <RichComposer key={draftKey} item={item} thread={thread} draftKey={draftKey} autoFocus={autoFocus} />
}

function RichComposer({ item, thread, draftKey, autoFocus }: { item: InboxItem; thread?: string; draftKey: string; autoFocus: boolean }) {
  const context = useFormatContext()
  const session = useRuntime().session
  const focusRequest = useStore((state) => state.composerFocusRequest)
  const focusChannel = useStore((state) => state.composerFocusChannel)
  const handledFocus = useRef(focusRequest)
  const sending = useDraftSending((state) => Boolean(state.pending[draftKey]))
  const sentId = useDraftSending((state) => state.sent[draftKey])
  const [initialDraft] = useState(() => readDraft(draftKey))
  const draft = useRef(initialDraft)
  const [error, setError] = useState<string>()
  const [gifRequest, setGifRequest] = useState<{ query: string }>()
  const openGif = useRef((query = '') => setGifRequest({ query }))
  const suggestionsOpen = useRef(false)
  const contextRef = useRef(context)
  useEffect(() => { contextRef.current = context }, [context])
  const lastTyping = useRef(0)
  const label = conversationLabel(item.conversation, context.users, session)
  const placeholder = thread ? 'Reply in thread' : `Message ${label}`
  const placeholderRef = useRef(placeholder)
  const submitRef = useRef<() => Promise<void>>(async () => {})

  const extensions = useMemo(() => {
    const render = suggestionMenu((open) => { suggestionsOpen.current = open })
    const SlashCommands = Extension.create({
      name: 'slashCommands',
      addProseMirrorPlugins() {
        return [Suggestion<ComposerSuggestion>({
          pluginKey: new PluginKey('slashCommands'),
          editor: this.editor, char: '/', startOfLine: true,
          allow: ({ range }) => range.from === 1,
          items: ({ query }) => 'gif'.startsWith(query.toLowerCase()) ? [GIF_COMMAND] : [],
          command: ({ editor, range }) => {
            editor.chain().focus().deleteRange(range).run()
            openGif.current()
          },
          render: suggestionMenu((open) => { suggestionsOpen.current = open }, 'commands'),
        })]
      },
    })
    const Emoji = Node.create({
      name: 'emoji', group: 'inline', inline: true, atom: true,
      addAttributes: () => ({ name: { default: '' }, glyph: { default: undefined }, image: { default: undefined } }),
      parseHTML: () => [{ tag: 'span[data-emoji]' }],
      renderHTML({ node, HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { 'data-emoji': node.attrs.name, class: 'composer-emoji', title: `:${node.attrs.name}:` }),
          node.attrs.image ? ['img', { src: node.attrs.image, alt: `:${node.attrs.name}:` }] : (node.attrs.glyph ?? `:${node.attrs.name}:`)]
      },
      renderText: ({ node }) => `:${node.attrs.name}:`,
      addProseMirrorPlugins() {
        return [Suggestion<ComposerSuggestion>({
          editor: this.editor, char: ':', allowSpaces: false,
          items: ({ query }) => {
            const custom = contextRef.current.emoji
            return [...new Set([...Object.keys(custom), ...Object.keys(standardEmoji)])]
              .filter((name) => name.includes(query.toLowerCase())).slice(0, 8)
              .map((name) => ({ id: name, label: `:${name}:`, ...emojiAppearance(name, custom) }))
          },
          command: ({ editor, range, props }) => editor.chain().focus().insertContentAt(range, [
            { type: 'emoji', attrs: { name: props.id, image: props.image, glyph: props.glyph } }, { type: 'text', text: ' ' },
          ]).run(),
          render,
        })]
      },
    })
    return [
      StarterKit.configure({ heading: false, horizontalRule: false, underline: false, link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      Mention.configure({
        HTMLAttributes: { class: 'composer-mention' },
        suggestion: {
          items: ({ query }) => [
            ...['here', 'channel', 'everyone'].map((name) => ({ id: name, label: name, detail: 'Notify members' })),
            ...Object.values(contextRef.current.users).map((user) => ({ id: user.id, label: user.displayName || user.handle, detail: user.handle, image: user.avatar })),
          ].filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8),
          render,
        },
      }),
      Emoji,
      SlashCommands,
    ]
  }, [])

  const editor = useEditor({
    extensions,
    editable: !sending,
    content: initialDraft?.document,
    editorProps: {
      attributes: { 'aria-label': placeholder, role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown(view, event) {
        if (event.isComposing || view.composing || suggestionsOpen.current) return false
        if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          void submitRef.current()
          return true
        }
        if (event.key === 'Escape') {
          commands.clearThreadTarget()
          view.dom.blur()
          return true
        }
        return false
      },
    },
    onUpdate({ editor }) {
      try {
        if (editor.isEmpty) localStorage.removeItem(draftKey)
        else {
          draft.current = { document: editor.getJSON(), clientMsgId: crypto.randomUUID() }
          saveDraft(draftKey, draft.current)
        }
      } catch { setError('Could not save this draft on this device.') }
      if (editor.isFocused && !editor.isEmpty && Date.now() - lastTyping.current >= 3000) {
        lastTyping.current = Date.now()
        void window.slackDesktop?.sendTyping(item.conversation.id).catch(() => {})
      }
    },
  })
  const empty = useEditorState({ editor, selector: ({ editor }) => editor?.isEmpty ?? true })

  useEffect(() => {
    placeholderRef.current = placeholder
    editor?.setOptions({ editorProps: { attributes: { 'aria-label': placeholder, role: 'textbox', 'aria-multiline': 'true' } } })
  }, [editor, placeholder])

  useEffect(() => {
    if (autoFocus) editor?.commands.focus()
  }, [editor, autoFocus])

  useEffect(() => {
    if (focusRequest !== handledFocus.current && focusChannel === item.conversation.id) editor?.commands.focus()
    handledFocus.current = focusRequest
  }, [editor, focusRequest, focusChannel, item.conversation.id])

  useEffect(() => {
    submitRef.current = async () => {
      if (!editor || useDraftSending.getState().pending[draftKey] || editor.isEmpty) return
      const document = editor.getJSON()
      const message = serializeMessage(document)
      if (!message.text.trim()) return
      const gifCommand = /^\/gif(?:\s+(.*))?$/is.exec(editor.getText().trim())
      if (gifCommand) {
        openGif.current(gifCommand[1]?.trim() ?? '')
        editor.commands.clearContent()
        draft.current = undefined
        return
      }
      const clientMsgId = draft.current?.clientMsgId ?? crypto.randomUUID()
      useDraftSending.getState().setPending(draftKey, true)
      setError(undefined)
      editor.setEditable(false, false)
      try {
        await commands.send({ ...message, clientMsgId }, item, thread)
        clearSentDraft(draftKey, clientMsgId)
        useDraftSending.getState().markSent(draftKey, clientMsgId)
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not send this message. Your draft has been kept.')
      } finally {
        useDraftSending.getState().setPending(draftKey, false)
      }
    }
  }, [editor, item, thread, draftKey])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!sending, false)
    if (!sending && draft.current?.clientMsgId === sentId && sentId) {
      editor.commands.clearContent()
      draft.current = undefined
    }
  }, [editor, sending, sentId])

  const parent = thread ? findMessage(item, thread) : undefined
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); void submitRef.current() }}>
    {thread && <div className="composer-context">
      Replying in thread{parent ? ` to ${authorName(parent, context.users)}` : ''}
      {!item.thread && <button type="button" className="link-button" onClick={() => commands.clearThreadTarget()}>Cancel</button>}
    </div>}
    <div className="composer-row">
      <GifPicker request={gifRequest} disabled={sending} destination={thread ? `Reply in thread in ${label}` : `Send to ${label}`}
        onClose={() => editor?.commands.focus()}
        onSend={async (gif, clientMsgId) => {
          if (useDraftSending.getState().pending[draftKey]) throw new Error('A message is already being sent. Please wait a moment.')
          useDraftSending.getState().setPending(draftKey, true)
          try {
            await commands.send({ text: gif.title, gif: { url: gif.url, title: gif.title }, clientMsgId }, item, thread)
          } finally { useDraftSending.getState().setPending(draftKey, false) }
        }} />
      <EditorContent editor={editor} className="rich-composer" />
      <button className="send-button" type="submit" disabled={sending || empty} aria-label={sending ? 'Sending' : 'Send message'} title="Send message (Enter)"><ArrowUpIcon /></button>
    </div>
    {editor && <BubbleMenu editor={editor} className="composer-formatting">
      <button type="button" aria-label="Bold" title="Bold (⌘B)" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()}><strong>B</strong></button>
      <button type="button" aria-label="Italic" title="Italic (⌘I)" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()}><em>I</em></button>
      <button type="button" aria-label="Strikethrough" title="Strikethrough" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></button>
      <button type="button" aria-label="Inline code" title="Inline code" onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleCode().run()}>&lt;&gt;</button>
    </BubbleMenu>}
    {error && <p role="alert" className="composer-error">{error}</p>}
  </form>
}
