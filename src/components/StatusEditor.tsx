import { useEffect, useRef, useState } from 'react'
import { localApi } from '../api'
import { reconcile, userCollection } from '../collections'
import { renderEmoji } from '../format'
import { useFormatContext } from '../hooks'
import emojiData from '../slack/emoji-data.json'
import type { User } from '../slack/types'

const common = ['speech_balloon', 'calendar', 'headphones', 'palm_tree', 'house', 'face_with_thermometer', 'coffee']

export function StatusEditor({ user, onClose }: { user: User; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const context = useFormatContext()
  const currentExpiration = user.statusExpiration && user.statusExpiration > Date.now() / 1000 ? user.statusExpiration : 0
  const [text, setText] = useState(user.statusText ?? '')
  const [emoji, setEmoji] = useState(user.statusEmoji?.replace(/^:|:$/g, '') || 'speech_balloon')
  const [expiration, setExpiration] = useState(currentExpiration ? 'current' : 'never')
  const [choosingEmoji, setChoosingEmoji] = useState(false)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const names = [...new Set([...common, ...Object.keys(context.emoji), ...Object.keys(emojiData)])]
  const matches = names.filter((name) => name.includes(query.toLowerCase().replaceAll(' ', '_'))).slice(0, 80)

  useEffect(() => { dialog.current?.showModal() }, [])

  const save = async () => {
    setSaving(true)
    setError(undefined)
    const now = new Date()
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const expires = expiration === 'current' ? currentExpiration : expiration === 'today' ? Math.floor(endOfDay.getTime() / 1000)
      : expiration === 'never' ? 0 : Math.floor(now.getTime() / 1000) + Number(expiration) * 3600
    try {
      const result = await localApi.setCustomStatus(text.trim(), `:${emoji}:`, expires)
      reconcile(userCollection, [result.user], false)
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not update your status.')
    } finally { setSaving(false) }
  }

  return <dialog ref={dialog} className="status-editor" aria-label="Set a status" onClose={onClose}
    onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}
    onCancel={(event) => { if (saving) event.preventDefault() }} onKeyDown={(event) => event.stopPropagation()}>
    <form onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="status-editor-message">
        <button type="button" className="status-emoji-choice" aria-label="Choose status emoji" disabled={saving} onClick={() => setChoosingEmoji(!choosingEmoji)}>{renderEmoji(emoji, context)}</button>
        <input autoFocus aria-label="Status text" placeholder="What's your status?" maxLength={100} value={text} disabled={saving} onChange={(event) => setText(event.target.value)} />
      </div>
      {choosingEmoji && <div className="status-emoji-picker">
        <input aria-label="Search status emoji" placeholder="Search emoji" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="reaction-picker-grid">{matches.map((name) => <button key={name} type="button" title={`:${name}:`} aria-label={name.replaceAll('_', ' ')} onClick={() => { setEmoji(name); setChoosingEmoji(false) }}>{renderEmoji(name, context)}</button>)}</div>
        {!matches.length && <p className="muted">No emoji found</p>}
      </div>}
      <div className="status-editor-actions">
        <select className="status-expiration" aria-label="Clear status after" value={expiration} disabled={saving} onChange={(event) => setExpiration(event.target.value)}>
          {currentExpiration > 0 && <option value="current">Clear after {new Date(currentExpiration * 1000).toLocaleString()}</option>}
          <option value="1">Clear after 1 hour</option><option value="4">Clear after 4 hours</option><option value="today">Clear after today</option><option value="never">Don't clear</option>
        </select>
        <button type="button" className="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="submit" className="button status-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      {error && <p role="alert" className="account-error">{error}</p>}
    </form>
  </dialog>
}
