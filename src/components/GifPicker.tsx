import { useEffect, useId, useRef, useState } from 'react'
import { browseGifs, gifsConfigured, type Gif } from '../gifs'
import { ArrowLeftIcon, CloseIcon, PlusIcon } from './Icons'

export function GifPicker({ request, disabled, destination, onSend, onClose }: {
  request?: { query: string }
  disabled: boolean
  destination: string
  onSend: (gif: Gif, clientMsgId: string) => Promise<void>
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
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [gifs, setGifs] = useState<Gif[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [selection, setSelection] = useState<{ gif: Gif; clientMsgId: string }>()
  const [sending, setSending] = useState(false)
  const busy = useRef(false)

  const position = (panel: HTMLDivElement, width: number) => {
    const bounds = trigger.current!.getBoundingClientRect()
    panel.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`
    panel.style.bottom = `${Math.max(8, window.innerHeight - bounds.top + 12)}px`
  }

  const showBrowser = (initialQuery: string) => {
    menu.current?.hidePopover()
    setQuery(initialQuery)
    setOffset(0)
    setGifs([])
    setSelection(undefined)
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
      void browseGifs(query.trim(), offset, abort.signal).then((result) => {
        if (abort.signal.aborted) return
        setGifs((previous) => offset ? [...previous, ...result.gifs] : result.gifs)
        setNextOffset(result.nextOffset)
        setHasMore(result.hasMore)
      }).catch((error) => {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load GIFs. Please try again.')
      }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    }, query ? 350 : 0)
    return () => { clearTimeout(timer); abort.abort() }
  }, [open, query, offset, retry])

  const send = async () => {
    if (!selection || busy.current || disabled) return
    busy.current = true
    setSending(true)
    setError(undefined)
    try {
      await onSend(selection.gif, selection.clientMsgId)
      browser.current?.hidePopover()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not send this GIF. Please try again.')
    } finally { busy.current = false; setSending(false) }
  }

  return <>
    <button ref={trigger} type="button" className="composer-add-button" aria-label="Add to message" title="Add to message" disabled={disabled} popoverTarget={menuId}
      onClick={() => position(menu.current!, 180)}><PlusIcon /></button>
    <div ref={menu} id={menuId} popover="auto" className="composer-add-menu" aria-label="Add to message" onKeyDown={(event) => event.stopPropagation()}>
      <button type="button" onClick={() => showBrowser('')}><span className="gif-label" aria-hidden="true">GIF</span> GIF</button>
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
        {selection && <button type="button" className="icon-button" aria-label="Back to GIFs" disabled={sending} onClick={() => { setSelection(undefined); setError(undefined) }}><ArrowLeftIcon /></button>}
        <strong>{selection ? 'Send GIF' : 'GIFs'}</strong>
        <button type="button" className="icon-button" aria-label="Close GIF browser" onClick={() => browser.current?.hidePopover()}><CloseIcon /></button>
      </div>
      {selection ? <>
        <div className="gif-preview"><img src={selection.gif.url} alt={selection.gif.title} /></div>
        <p className="gif-destination">{destination}</p>
        <button type="button" className="gif-send button primary" disabled={sending || disabled} onClick={() => void send()}>{sending ? 'Sending…' : 'Send GIF'}</button>
      </> : <>
        <input ref={search} aria-label="Search GIFs" placeholder="Search GIFs" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); setGifs([]); setHasMore(false) }} />
        <div className="gif-picker-results" aria-busy={loading}>
          <div className="gif-picker-grid">
            {gifs.map((gif) => <button key={gif.id} type="button" aria-label={`Preview ${gif.title}`} onClick={() => { setSelection({ gif, clientMsgId: crypto.randomUUID() }); setError(undefined) }}>
              <img src={gif.preview} alt={gif.title} loading="lazy" />
            </button>)}
          </div>
          {loading && <p className="muted" role="status">Loading GIFs…</p>}
          {!loading && !error && !gifs.length && <p className="muted">No GIFs found. Try another search.</p>}
          {hasMore && !error && <button type="button" className="link-button gif-load-more" disabled={loading} onClick={() => setOffset(nextOffset)}>Load more</button>}
        </div>
      </>}
      {error && <p className="gif-error" role="alert">{error} {!selection && gifsConfigured && <button type="button" className="link-button" onClick={() => setRetry((value) => value + 1)}>Retry</button>}</p>}
      <img className="giphy-attribution" src="/powered-by-giphy.png" alt="Powered by GIPHY" />
    </div>
  </>
}
