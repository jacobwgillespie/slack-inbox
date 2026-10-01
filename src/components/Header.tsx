import { useViewCounts } from '../hooks'
import { inboxStore, useStore, VIEWS, type View } from '../store'
import { RefreshIcon } from './Icons'

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
      <nav className="section-tabs" aria-label="Conversations">
        {VIEWS.map((candidate, index) => (
          <button key={candidate} className={candidate === view ? 'active' : ''} aria-pressed={candidate === view}
            onClick={() => setView(candidate)} title={`${index + 1}`}>
            {VIEW_LABELS[candidate]} <span>{counts[candidate]}</span>
          </button>
        ))}
      </nav>
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
