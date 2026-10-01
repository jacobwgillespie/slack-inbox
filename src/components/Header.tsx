import type { CSSProperties } from 'react'
import { useViewCounts } from '../hooks'
import { inboxStore, useStore, VIEWS, type View } from '../store'
import { CheckIcon, HashIcon, RefreshIcon, ThreadIcon } from './Icons'

const VIEW_ICONS: Partial<Record<View, typeof CheckIcon>> = { dms: ThreadIcon, channels: HashIcon, done: CheckIcon }

const VIEW_LABELS: Record<View, string> = {
  important: 'Important',
  other: 'Other',
  later: 'Later',
  muted: 'Muted',
  dms: 'DMs',
  channels: 'Channels',
  done: 'Done',
}

export function Header() {
  const counts = useViewCounts()
  const view = useStore((state) => state.view)
  const sync = useStore((state) => state.sync)
  const scanning = Boolean(sync?.running)
  const showProgress = scanning && (Boolean(sync?.total) || !sync?.lastCompletedAt)
  const { setView, refresh, toggleHelp } = inboxStore.getState()

  return (
    <header className="header">
      <div className="sidebar-heading">
        {window.slackDesktop?.platform !== 'darwin' && <div className="brand">Inbox</div>}
        <div className="view-switcher" role="radiogroup" aria-label="Conversations"
          style={{ '--selected-view': Math.max(0, VIEWS.indexOf(view)) } as CSSProperties}>
          {VIEWS.map((candidate, index) => {
            const ViewIcon = VIEW_ICONS[candidate]!
            return (
              <button key={candidate} role="radio" aria-checked={candidate === view}
                aria-label={VIEW_LABELS[candidate]} tabIndex={candidate === view ? 0 : -1}
                onClick={() => setView(candidate)} title={`${VIEW_LABELS[candidate]} (${index + 1}) · ${counts[candidate]}`}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
                  event.preventDefault()
                  event.stopPropagation()
                  const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length
                  setView(VIEWS[next]!)
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
                }}>
                <ViewIcon />
              </button>
            )
          })}
        </div>
        <div className="header-tools">
          <button
            className={`icon-button${scanning ? ' spinning' : ''}`}
            onClick={refresh}
            disabled={scanning}
            title="Refresh (Shift+R)"
            aria-label="Refresh"
          >
            <RefreshIcon />
          </button>
          <button
            className="icon-button"
            onClick={toggleHelp}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>
        </div>
      </div>
      <div className="sync-status" role="status">
        {sync?.error && !scanning && (
          <span className="scan-status scan-error" title={sync.error.message}>
            Sync failed: {sync.error.code}
          </span>
        )}
        {sync?.realtime === 'disconnected' && <span className="scan-status">Reconnecting</span>}
        {sync?.classifier.error && (
          <span className="scan-status scan-error" title={sync.classifier.error}>
            Classifier failed
          </span>
        )}
        {sync?.classifier.running && sync.classifier.pending > 0 && (
          <span className="scan-status">Sorting {sync.classifier.pending}</span>
        )}
        {showProgress && (
          <span className="scan-status">
            {sync?.total ? `Syncing ${sync.done} of ${sync.total}` : 'Syncing'}
          </span>
        )}
      </div>
    </header>
  )
}
