import { useEffect, useId, useRef, useState } from 'react'
import { browseGifs, gifsConfigured, type Gif } from '../gifs'
import { CloseIcon, PlusIcon } from './Icons'
import { GIF_COMMAND } from './composer-suggestions'

export function GifPicker({ request, disabled, onSelect, onClose }: {
  request?: { query: string }
  disabled: boolean
  onSelect: (gif: Gif) => void
  onClose: () => void
}) {
  const menuId = useId()
  const browserId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const browser = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [nextPage, setNextPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [gifs, setGifs] = useState<Gif[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)

  const position = (panel: HTMLDivElement, width: number) => {
    const bounds = trigger.current!.getBoundingClientRect()
    const commandMenu = panel === menu.current
    const label = panel.querySelector<HTMLElement>('.suggestion-label')
    const labelOffset = label ? label.getBoundingClientRect().left - panel.getBoundingClientRect().left : 0
    panel.style.left = `${Math.max(8, Math.min(commandMenu ? bounds.right + 8 - labelOffset : bounds.left, window.innerWidth - width - 8))}px`
    panel.style.bottom = `${Math.max(8, window.innerHeight - bounds.top + (commandMenu ? 8 : 12))}px`
  }

  const showBrowser = (initialQuery: string) => {
    menu.current?.hidePopover()
    setQuery(initialQuery)
    setPage(1)
    setGifs([])
    setError(undefined)
    position(browser.current!, 420)
    browser.current?.showPopover()
  }

  useEffect(() => {
    if (request) showBrowser(request.query)
  }, [request])

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setLoading(true)
    setError(undefined)
    const timer = setTimeout(() => {
      void browseGifs(query.trim(), page, abort.signal).then((result) => {
        if (abort.signal.aborted) return
        setGifs((previous) => page > 1 ? [...previous, ...result.gifs] : result.gifs)
        setNextPage(result.nextPage)
        setHasMore(result.hasMore)
      }).catch((error) => {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load GIFs. Please try again.')
      }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    }, query ? 350 : 0)
    return () => { clearTimeout(timer); abort.abort() }
  }, [open, query, page, retry])

  return <>
    <button ref={trigger} type="button" className="composer-add-button" aria-label="Add to message" title="Add to message" disabled={disabled} popoverTarget={menuId}
      onClick={() => position(menu.current!, menu.current!.offsetWidth || 480)}><PlusIcon /></button>
    <div ref={menu} id={menuId} popover="auto" className="composer-suggestions composer-command-suggestions composer-command-popover" role="menu" aria-label="Commands"
      onToggle={(event) => {
        if (event.newState === 'open') {
          position(menu.current!, menu.current!.offsetWidth)
          menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') event.preventDefault()
      }}>
      <button type="button" role="menuitem" onClick={() => showBrowser('')}>
        <span className="suggestion-glyph" aria-hidden="true">{GIF_COMMAND.glyph}</span>
        <span className="suggestion-label">{GIF_COMMAND.label}</span>
        <small>{GIF_COMMAND.detail}</small>
        <span className="suggestion-kind">{GIF_COMMAND.kind}</span>
      </button>
    </div>
    <div ref={browser} id={browserId} popover="auto" role="dialog" aria-label="Choose a GIF" className="gif-picker"
      onKeyDown={(event) => event.stopPropagation()}
      onToggle={(event) => {
        const opened = event.newState === 'open'
        setOpen(opened)
        if (opened) search.current?.focus()
        else onClose()
      }}>
      <div className="gif-picker-header">
        <input ref={search} aria-label="Search GIFs" placeholder="Search KLIPY" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); setHasMore(false) }} />
        <button type="button" className="icon-button" aria-label="Close GIF browser" onClick={() => browser.current?.hidePopover()}><CloseIcon /></button>
      </div>
      <div className="gif-picker-results" aria-busy={loading}>
        <div className="gif-picker-grid">
          {gifs.map((gif) => <button key={gif.id} type="button" aria-label={`Select ${gif.title}`} onClick={() => { onSelect(gif); browser.current?.hidePopover() }}>
            <img src={gif.preview} alt={gif.title} loading="lazy" />
          </button>)}
        </div>
        {loading && !gifs.length && <p className="muted" role="status">Loading GIFs…</p>}
        {!loading && !error && !gifs.length && <p className="muted">No GIFs found. Try another search.</p>}
        {hasMore && !error && <button type="button" className="link-button gif-load-more" disabled={loading} onClick={() => setPage(nextPage)}>Load more</button>}
      </div>
      {error && <p className="gif-error" role="alert">{error} {gifsConfigured && <button type="button" className="link-button" onClick={() => setRetry((value) => value + 1)}>Retry</button>}</p>}
      <p className="gif-attribution">Powered by KLIPY</p>
    </div>
  </>
}
