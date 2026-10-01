import { useEffect, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { ArrowUpIcon } from './Icons'
import { useStore } from '../store'
import type { InboxItem } from '../slack/types'
import { readComposerSelection, restoreComposerSelection, type ComposerAction, type ComposerSnapshot } from '../slack/composer'

const clean = (html: string) => DOMPurify.sanitize(html, { FORBID_TAGS: ['form', 'input', 'style'], FORBID_ATTR: ['autofocus'], ADD_ATTR: ['contenteditable'] })

export function SlackComposer({ item }: { item: InboxItem }) {
  const host = useRef<HTMLDivElement>(null)
  const generation = useRef<number | undefined>(undefined)
  const pending = useRef<ComposerAction | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const composing = useRef(false)
  const [ready, setReady] = useState(false)
  const [sendButton, setSendButton] = useState<{ id: string; disabled: boolean }>()
  const selected = useStore((state) => state.selectedId === item.id)
  const focusRequest = useStore((state) => state.composerFocusRequest)
  const focusChannel = useStore((state) => state.composerFocusChannel)
  const handledFocus = useRef(focusRequest)
  const editor = () => host.current?.querySelector<HTMLElement>('[data-slack-editor]')

  const flush = () => {
    clearTimeout(timer.current)
    if (generation.current === undefined || !pending.current) return
    const action = pending.current
    pending.current = undefined
    void window.slackDesktop?.composerAction(generation.current, action).catch(console.error)
  }
  const action = (value: ComposerAction) => {
    flush()
    if (generation.current !== undefined) void window.slackDesktop?.composerAction(generation.current, value).catch(console.error)
  }

  useEffect(() => {
    const desktop = window.slackDesktop
    if (!desktop || !selected) return
    let cancelled = false
    let initial: ComposerSnapshot | undefined
    let token: number | undefined
    const accept = (snapshot: ComposerSnapshot) => {
      if (snapshot.channel !== item.conversation.id || cancelled) return
      if (token === undefined) { initial = snapshot; return }
      if (snapshot.generation !== token || !host.current) return
      const localEditor = editor()
      const editing = localEditor && document.activeElement === localEditor && !document.querySelector('.desktop-slack-toolbar')
      const scratch = document.createElement('div')
      scratch.innerHTML = clean(snapshot.html)
      const remoteEditor = scratch.querySelector<HTMLElement>('[data-slack-editor]')
      if (!remoteEditor) return
      const send = scratch.querySelector<HTMLButtonElement>('[data-qa="texty_send_button"]')
      setSendButton(send?.dataset.slackAction ? {
        id: send.dataset.slackAction,
        disabled: send.disabled || send.getAttribute('aria-disabled') === 'true',
      } : undefined)
      scratch.replaceChildren(remoteEditor, ...scratch.querySelectorAll('[data-slack-suggestions]'))
      // Keep the live local editor and its selection during typing. Replace the
      // surrounding copied controls so Slack can update buttons and suggestions.
      const authoritative = snapshot.source === 'inbox' && snapshot.action !== 'input' && remoteEditor.innerHTML !== localEditor?.innerHTML
      const popupScroll = host.current.querySelector('[data-slack-suggestions]')?.scrollTop ?? 0
      if (localEditor && !authoritative && (editing || pending.current || composing.current)) {
        for (const button of scratch.querySelectorAll<HTMLButtonElement>('button[data-slack-action]')) {
          const local = host.current.querySelector<HTMLButtonElement>(`button[data-slack-action="${button.dataset.slackAction}"]`)
          if (local) {
            local.disabled = button.disabled
            local.setAttribute('aria-disabled', button.getAttribute('aria-disabled') ?? 'false')
          }
        }
        host.current.querySelectorAll('[data-slack-suggestions]').forEach((popup) => popup.remove())
        host.current.append(...scratch.querySelectorAll('[data-slack-suggestions]'))
      } else {
        host.current.replaceChildren(...scratch.childNodes)
        if (authoritative && editing) {
          editor()?.focus({ preventScroll: true })
          if (editor()) restoreComposerSelection(editor()!, snapshot.selection)
        }
      }
      const popup = host.current.querySelector<HTMLElement>('[data-slack-suggestions]')
      if (popup) {
        popup.scrollTop = popupScroll
        const active = popup.querySelector<HTMLElement>('[role="option"][aria-selected="true"], .c-texty_autocomplete__result--pseudo-selected')
        if (active) {
          const top = active.offsetTop
          const bottom = top + active.offsetHeight
          if (top < popup.scrollTop) popup.scrollTop = top
          else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight
        }
      }
      setReady(true)
    }
    const unsubscribe = desktop.onComposerChange(accept)
    void desktop.followComposer(item.conversation.id).then((value) => {
      token = value
      if (value === undefined) return
      if (cancelled) { void desktop.stopComposer(value); return }
      generation.current = value
      if (initial) accept(initial)
    }).catch(console.error)
    return () => {
      cancelled = true
      clearTimeout(timer.current)
      if (pending.current && token !== undefined) void desktop.composerAction(token, pending.current)
      pending.current = undefined
      generation.current = undefined
      unsubscribe()
      if (token !== undefined) void desktop.stopComposer(token)
    }
  }, [selected, item.conversation.id])

  useEffect(() => {
    if (focusRequest !== handledFocus.current && focusChannel === item.conversation.id) editor()?.focus()
    handledFocus.current = focusRequest
  }, [focusRequest, focusChannel, item.conversation.id])

  return (
    <div className="composer slack-composer">
      <div className="composer-row">
        {!ready && <div className="composer-connecting muted" role="status">Connecting Slack composer…</div>}
        <div
          ref={host}
          className="slack-composer-copy"
          onInput={() => {
            const element = editor()
            if (!element || composing.current) return
            element.classList.toggle('ql-blank', !element.innerText.trim())
            pending.current = { type: 'input', html: clean(element.innerHTML), selection: readComposerSelection(element) }
            clearTimeout(timer.current)
            timer.current = setTimeout(flush, 180)
          }}
          onPaste={(event) => {
            const html = event.clipboardData.getData('text/html')
            if (!html) return
            event.preventDefault()
            document.execCommand('insertHTML', false, clean(html))
          }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => {
            composing.current = false
            const element = editor()
            if (element) { pending.current = { type: 'input', html: clean(element.innerHTML), selection: readComposerSelection(element) }; flush() }
          }}
          onKeyDown={(event) => {
            const element = editor()
            if (!element || event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && event.shiftKey) return
            if (['Tab', 'ArrowUp', 'ArrowDown'].includes(event.key) && !host.current?.querySelector('[data-slack-suggestions]')) return
            if (['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
              event.preventDefault()
              event.stopPropagation()
              action({ type: 'key', key: event.key, selection: readComposerSelection(element) })
              if (event.key === 'Escape') element.blur()
            }
          }}
          onMouseDown={(event) => {
            if ((event.target as Element).closest('[data-slack-action]')) event.preventDefault()
          }}
          onClick={(event) => {
            const target = (event.target as Element).closest<HTMLElement>('[data-slack-action]')
            if (!target || target.closest('[data-slack-editor]') || target.matches(':disabled, [aria-disabled="true"]')) return
            event.preventDefault()
            const element = editor()
            action({ type: 'click', id: target.dataset.slackAction!, selection: element ? readComposerSelection(element) : undefined })
          }}
        />
        {ready && <button
          type="button"
          className="send-button"
          disabled={!sendButton || sendButton.disabled}
          aria-label="Send message"
          title="Send message (Enter)"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const element = editor()
            if (sendButton) action({ type: 'click', id: sendButton.id, selection: element ? readComposerSelection(element) : undefined })
          }}
        ><ArrowUpIcon /></button>}
      </div>
    </div>
  )
}
