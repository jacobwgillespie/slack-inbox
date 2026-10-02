import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { localApi } from '../api'
import { renderEmoji } from '../format'
import { useFormatContext } from '../hooks'
import type { Message, Reaction } from '../slack/types'
import { useStore } from '../store'

export function ReactionList({ channel, message, onChange }: {
  channel: string
  message: Message
  onChange: (reactions: Reaction[]) => Promise<void>
}) {
  const context = useFormatContext(message.emoji)
  const self = useStore((state) => state.session?.userId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [hover, setHover] = useState<{ name: string; button: HTMLButtonElement }>()
  const [details, setDetails] = useState<Awaited<ReturnType<typeof localApi.reactionDetails>>>()
  const [lookupFailed, setLookupFailed] = useState(false)
  const request = useRef<ReturnType<typeof localApi.reactionDetails> | undefined>(undefined)
  const tooltip = useRef<HTMLDivElement>(null)
  const tooltipId = useId()
  const [position, setPosition] = useState({ left: 0, top: 0 })

  function show(name: string, button: HTMLButtonElement) {
    setHover({ name, button })
    setLookupFailed(false)
    setDetails(undefined)
    if (request.current) return
    const pending = localApi.reactionDetails(channel, message.ts)
    request.current = pending
    void pending.then(setDetails, () => setLookupFailed(true)).finally(() => { request.current = undefined })
  }

  useLayoutEffect(() => {
    if (!hover || !tooltip.current) return
    const anchor = hover.button.getBoundingClientRect()
    const bounds = tooltip.current.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(anchor.left + anchor.width / 2 - bounds.width / 2, window.innerWidth - bounds.width - 8)),
      top: anchor.top >= bounds.height + 16 ? anchor.top - bounds.height - 8 : anchor.bottom + 8,
    })
  }, [hover, details, lookupFailed])

  useEffect(() => {
    if (!hover) return
    const close = () => setHover(undefined)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [hover])

  if (!message.reactions?.length) return null
  const reaction = hover && (details?.reactions ?? message.reactions).find((reaction) => reaction.name === hover.name)
  const users = { ...context.users, ...details?.users }
  const names = reaction?.users?.flatMap((id) => {
    const user = users[id]
    return id === self ? ['You'] : user ? [user.displayName || user.handle] : []
  }) ?? []
  const remaining = (reaction?.count ?? 0) - names.length

  return <div className="reactions">
    {message.reactions.map((reaction) => {
      const mine = reaction.users ? Boolean(self && reaction.users.includes(self)) : Boolean(reaction.mine)
      return <button key={reaction.name} className={`reaction${mine ? ' reaction-own' : ''}`} aria-pressed={mine}
        aria-label={`${mine ? 'Remove' : 'Add'} ${reaction.name} reaction, ${reaction.count}`} disabled={busy}
        aria-describedby={hover?.name === reaction.name ? tooltipId : undefined}
        onMouseEnter={(event) => show(reaction.name, event.currentTarget)} onMouseLeave={() => setHover(undefined)}
        onFocus={(event) => show(reaction.name, event.currentTarget)} onBlur={() => setHover(undefined)}
        onKeyDown={(event) => { if (event.key === 'Escape') setHover(undefined) }}
        onClick={async (event) => {
          event.stopPropagation()
          setHover(undefined)
          setDetails(undefined)
          setBusy(true)
          setError(undefined)
          try {
            const result = await (mine ? localApi.removeReaction : localApi.addReaction)(channel, message.ts, reaction.name)
            await onChange(result.reactions)
          } catch (error) { setError(error instanceof Error ? error.message : 'Could not update reaction') }
          finally { setBusy(false) }
        }}>{renderEmoji(reaction.name, context)} {reaction.count}</button>
    })}
    {error && <span className="reaction-picker-error" role="alert">{error}</span>}
    {hover && createPortal(<div ref={tooltip} id={tooltipId} role="tooltip" className="reaction-tooltip" style={position}>
      <span className="reaction-tooltip-emoji">{renderEmoji(hover.name, context)}</span>
      <span>{names.length ? <>{names.join(', ')}{remaining > 0 && ` and ${remaining} ${remaining === 1 ? 'other' : 'others'}`} reacted</>
        : details && !reaction ? 'No one has reacted' : details || lookupFailed ? 'Could not load who reacted' : 'Loading…'}</span>
    </div>, document.body)}
  </div>
}
