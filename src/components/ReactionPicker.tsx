import { useId, useRef, useState } from 'react'
import { localApi } from '../api'
import { renderEmoji } from '../format'
import { useFormatContext } from '../hooks'
import emojiData from '../slack/emoji-data.json'
import type { Reaction } from '../slack/types'
import { ReactionIcon } from './Icons'

const common = ['thumbsup', 'heart', 'tada', 'joy', 'eyes', 'white_check_mark', 'rocket', '100']

export function ReactionPicker({ channel, ts, onReact }: { channel: string; ts: string; onReact: (reactions: Reaction[]) => void }) {
  const id = useId()
  const picker = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const context = useFormatContext()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const names = [...new Set([...common, ...Object.keys(context.emoji), ...Object.keys(emojiData)])]
  const matches = query.trim()
    ? names.filter((name) => name.includes(query.trim().toLowerCase().replaceAll(' ', '_'))).slice(0, 80)
    : names.slice(0, 80)

  const react = async (name: string) => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await localApi.addReaction(channel, ts, name)
      onReact(result.reactions)
      picker.current?.hidePopover()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not add reaction')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <button className="icon-button" aria-label="Add reaction" title="Add reaction" popoverTarget={id} onClick={(event) => {
      event.stopPropagation()
      const bounds = event.currentTarget.getBoundingClientRect()
      const panel = picker.current!
      panel.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 312))}px`
      panel.style.top = `${Math.max(8, Math.min(bounds.bottom + 8, window.innerHeight - 348))}px`
    }}><ReactionIcon /></button>
    <div ref={picker} id={id} className="reaction-picker" popover="auto" aria-label="Choose a reaction" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onToggle={(event) => {
      if (event.newState === 'open') {
        setQuery('')
        setError(undefined)
        search.current?.focus()
      }
    }}>
      <input ref={search} aria-label="Search emoji" placeholder="Search emoji" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="reaction-picker-grid">
        {matches.map((name) => <button key={name} title={`:${name}:`} aria-label={name.replaceAll('_', ' ')} disabled={busy} onClick={() => void react(name)}>{renderEmoji(name, context)}</button>)}
      </div>
      {!matches.length && <p className="muted">No emoji found</p>}
      {error && <p role="alert" className="reaction-picker-error">{error}</p>}
    </div>
  </>
}
