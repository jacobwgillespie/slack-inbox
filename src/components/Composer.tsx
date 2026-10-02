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
import { readPastedImage, removePastedImage, storePastedImage, type DraftImage } from '../composer-images'
import { localApi } from '../api'
import { serializeMessage } from '../slack/rich-text'
import emojiData from '../slack/emoji-data.json'
import { prioritizeEmoji, recordEmojiAcceptance } from '../emoji-usage'
import type { InboxItem } from '../slack/types'
import type { Gif } from '../gifs'
import { ArrowUpIcon, CloseIcon } from './Icons'
import { GIF_COMMAND, mentionSuggestions, suggestionMenu, type ComposerSuggestion } from './composer-suggestions'
import { GifPicker } from './GifPicker'
import { ComposerImage } from './ComposerImage'

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
  const [pendingGif, setPendingGif] = useState(initialDraft?.gif)
  const [pendingImages, setPendingImages] = useState(initialDraft?.images ?? [])
  const [pasting, setPasting] = useState(false)
  const pasteCount = useRef(0)
  const pasteImages = useRef<(files: File[]) => void>(() => {})
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
            return prioritizeEmoji([...new Set([...Object.keys(custom), ...Object.keys(standardEmoji)])], query)
              .slice(0, 8)
              .map((name) => ({ id: name, label: `:${name}:`, ...emojiAppearance(name, custom) }))
          },
          command: ({ editor, range, props }) => {
            const inserted = editor.chain().focus().insertContentAt(range, [
              { type: 'emoji', attrs: { name: props.id, image: props.image, glyph: props.glyph } }, { type: 'text', text: ' ' },
            ]).run()
            if (inserted) recordEmojiAcceptance(props.id)
          },
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
          items: ({ query }) => mentionSuggestions(contextRef.current.users, query),
          render: suggestionMenu((open) => { suggestionsOpen.current = open }, 'mentions'),
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
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.items ?? [])]
          .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile()).filter((file): file is File => Boolean(file))
        if (!files.length) return false
        event.preventDefault()
        pasteImages.current(files)
        return true
      },
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
        if (editor.isEmpty && !draft.current?.gif && !draft.current?.images?.length) {
          localStorage.removeItem(draftKey)
          draft.current = undefined
        }
        else {
          draft.current = { document: editor.getJSON(), gif: draft.current?.gif, images: draft.current?.images, clientMsgId: crypto.randomUUID() }
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

  const changeImages = (images: DraftImage[]) => {
    if (!editor) return
    setPendingImages(images)
    if (editor.isEmpty && !draft.current?.gif && !images.length) {
      draft.current = undefined
      localStorage.removeItem(draftKey)
    } else {
      draft.current = { document: editor.getJSON(), gif: draft.current?.gif, images, clientMsgId: crypto.randomUUID() }
      try { saveDraft(draftKey, draft.current) } catch { setError('Could not save this draft on this device.') }
    }
  }
  pasteImages.current = (files) => {
    if (!editor || useDraftSending.getState().pending[draftKey]) return
    pasteCount.current++
    setPasting(true)
    setError(undefined)
    void (async () => {
      try {
        for (const file of files) {
          if (file.size > 50 * 1024 * 1024) throw new Error('Images must be smaller than 50 MB.')
          const image = await storePastedImage(file)
          changeImages([...(draft.current?.images ?? []), image])
        }
      } catch (error) { setError(error instanceof Error ? error.message : 'Could not attach this image.') }
      finally { pasteCount.current--; setPasting(pasteCount.current > 0) }
    })()
  }

  const removeImage = (id: string) => {
    changeImages((draft.current?.images ?? []).filter((image) => image.id !== id))
    void removePastedImage(id).catch(console.error)
    editor?.commands.focus()
  }

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
      if (!editor || useDraftSending.getState().pending[draftKey] || pasteCount.current) return
      const gif = draft.current?.gif
      const images = draft.current?.images ?? []
      if (editor.isEmpty && !gif && !images.length) return
      const document = editor.getJSON()
      const message = serializeMessage(document)
      if (!message.text.trim() && !gif && !images.length) return
      const gifCommand = /^\/gif(?:\s+(.*))?$/is.exec(editor.getText().trim())
      if (gifCommand && !gif && !images.length) {
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
        const files = []
        for (const image of images) {
          image.uploaded ??= await localApi.uploadImage(await readPastedImage(image.id), image.name)
          files.push(image.uploaded)
          if (draft.current) saveDraft(draftKey, draft.current)
        }
        await commands.send({ ...message, text: message.text || gif?.title || '', gif: gif && { url: gif.url, title: gif.title }, files: files.length ? files : undefined, clientMsgId }, item, thread)
        clearSentDraft(draftKey, clientMsgId)
        useDraftSending.getState().markSent(draftKey, clientMsgId)
        for (const image of images) void removePastedImage(image.id).catch(console.error)
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
      draft.current = undefined
      editor.commands.clearContent()
      setPendingGif(undefined)
      setPendingImages([])
    }
  }, [editor, sending, sentId])

  const changeGif = (gif?: Gif) => {
    if (!editor || sending) return
    setPendingGif(gif)
    setError(undefined)
    if (editor.isEmpty && !gif && !draft.current?.images?.length) {
      draft.current = undefined
      localStorage.removeItem(draftKey)
    } else {
      draft.current = { document: editor.getJSON(), gif, images: draft.current?.images, clientMsgId: crypto.randomUUID() }
      try { saveDraft(draftKey, draft.current) } catch { setError('Could not save this draft on this device.') }
    }
    editor.commands.focus()
  }

  const parent = thread ? findMessage(item, thread) : undefined
  return <form className="composer" onKeyDownCapture={(event) => {
    if (event.key === 'Escape' && (pendingGif || pendingImages.length) && !sending && !suggestionsOpen.current && !(event.target as HTMLElement).closest('.gif-picker, .composer-suggestions')) {
      event.preventDefault()
      event.stopPropagation()
      if (pendingGif) changeGif()
      else removeImage(pendingImages[pendingImages.length - 1]!.id)
    }
  }} onSubmit={(event) => { event.preventDefault(); void submitRef.current() }}>
    {thread && <div className="composer-context">
      Replying in thread{parent ? ` to ${authorName(parent, context.users)}` : ''}
      {!item.thread && <button type="button" className="link-button" onClick={() => commands.clearThreadTarget()}>Cancel</button>}
    </div>}
    <div className="composer-row">
      <GifPicker request={gifRequest} disabled={sending} onClose={() => editor?.commands.focus()} onSelect={changeGif} />
      <div className="rich-composer">
        {pendingImages.length > 0 && <div className="composer-images">{pendingImages.map((image) =>
          <ComposerImage key={image.id} image={image} disabled={sending} onRemove={() => removeImage(image.id)} />
        )}</div>}
        {pendingGif && <div className="composer-gif">
          <img src={pendingGif.preview} alt={pendingGif.title} />
          <button type="button" aria-label="Remove GIF" title="Remove GIF (Escape)" disabled={sending} onClick={() => changeGif()}><CloseIcon /></button>
        </div>}
        <EditorContent editor={editor} />
      </div>
      <button className="send-button" type="submit" disabled={sending || pasting || (empty && !pendingGif && !pendingImages.length)} aria-label={sending ? 'Sending' : 'Send message'} title="Send message (Enter)"><ArrowUpIcon /></button>
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
