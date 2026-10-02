import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { localApi } from '../api'
import { commands } from '../commands'
import { messageCollection } from '../collections'
import { readCachedConversation } from '../useCachedConversation'
import type { Message } from '../slack/types'
import { DeleteIcon, EditIcon } from './Icons'

export function MessageMenu({ x, y, onClose, onAction }: {
  x: number; y: number; onClose: () => void; onAction: (action: 'edit' | 'delete') => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const panel = menu.current!
    panel.showPopover()
    panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - panel.offsetWidth - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - panel.offsetHeight - 8))}px`
    panel.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [x, y])
  const act = (action: 'edit' | 'delete') => { onAction(action); onClose() }
  return createPortal(<div ref={menu} popover="auto" role="menu" aria-label="Message actions" className="item-context-menu"
    onToggle={(event) => { if (event.newState === 'closed') onClose() }}
    onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }
    }}>
    <button role="menuitem" onClick={() => act('edit')}><EditIcon /><span>Edit message</span></button>
    <button role="menuitem" className="message-delete" onClick={() => act('delete')}><DeleteIcon /><span>Delete message</span></button>
  </div>, document.body)
}

export function MessageEditor({ channel, message, action, onClose }: {
  channel: string; message: Message; action: 'edit' | 'delete'; onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(message.text)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const deleting = action === 'delete'
  const hasImages = Boolean(message.files?.length || message.blocks?.some((block) => block.type === 'image'))
  useEffect(() => { dialog.current?.showModal() }, [])
  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      const id = `${channel}:${message.ts}`
      if (deleting) {
        await localApi.deleteMessage(channel, message.ts)
        if (messageCollection.has(id)) messageCollection.delete(id)
      } else {
        const result = await localApi.editMessage(channel, message.ts, text)
        if (messageCollection.has(id)) messageCollection.update(id, (draft) => { Object.assign(draft, result.message) })
      }
      void readCachedConversation(channel).catch(console.error)
      void commands.load().catch(console.error)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Could not ${action} this message.`)
    } finally { setSaving(false) }
  }
  return createPortal(<dialog ref={dialog} className="message-editor" aria-label={deleting ? 'Delete message' : 'Edit message'}
    onClose={onClose} onCancel={(event) => { if (saving) event.preventDefault() }}
    onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !saving) onClose() }}
    onKeyDown={(event) => event.stopPropagation()}>
    <form onSubmit={(event) => { event.preventDefault(); void save() }}>
      {deleting ? <p>Delete this message? This cannot be undone.</p> :
        <textarea autoFocus aria-label="Message text" value={text} disabled={saving} rows={5} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!saving && (text.trim() || hasImages)) void save() } }} />}
      {error && <p role="alert" className="account-error">{error}</p>}
      <div className="message-editor-actions">
        <button type="button" className="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="submit" className={`button ${deleting ? 'message-delete' : 'status-save'}`} disabled={saving || (!deleting && ((!text.trim() && !hasImages) || text === message.text))}>
          {saving ? (deleting ? 'Deleting…' : 'Saving…') : (deleting ? 'Delete' : 'Save')}
        </button>
      </div>
    </form>
  </dialog>, document.body)
}
