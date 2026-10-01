import { useViewCounts } from '../hooks'
import { useStore, VIEWS, type View } from '../store'
import { RefreshIcon } from './Icons'

const VIEW_LABELS: Record<View, string> = {
  important: 'Important',
  other: 'Other',
  later: 'Later',
  muted: 'Muted',
  dms: 'DMs',
}

export function Header() {
  const counts = useViewCounts()
  const view = useStore((state) => state.view)
  const sync = useStore((state) => state.sync)
  const scanning = Boolean(sync?.running)
  const showProgress = scanning && (Boolean(sync?.total) || !sync?.lastCompletedAt)
  const { setView, refresh, toggleHelp } = useStore.getState()

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
      <nav className="section-tabs" aria-label="Inbox or direct messages">
        <button className={view !== 'dms' ? 'active' : ''} aria-pressed={view !== 'dms'} onClick={() => setView('important')}>Inbox</button>
        <button className={view === 'dms' ? 'active' : ''} aria-pressed={view === 'dms'} onClick={() => setView('dms')}>
          DMs <span>{counts.dms}</span>
        </button>
      </nav>
      {view !== 'dms' && (
        <nav className="tabs" aria-label="Views">
          {VIEWS.filter((candidate) => candidate !== 'dms').map((candidate, index) => (
            <button
              key={candidate}
              className={`tab${candidate === view ? ' active' : ''}`}
              onClick={() => setView(candidate)}
              title={`${index + 1}`}
              aria-pressed={candidate === view}
            >
              {VIEW_LABELS[candidate]}
              <span className="tab-count">{counts[candidate]}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="sync-status" role="status">
        {sync?.error && !scanning && (
          <span className="scan-status scan-error" title={sync.error.message}>
            Sync failed: {sync.error.code}
          </span>
        )}
        {sync?.realtime === 'connected' && (
          <span className="live-status" title="Receiving updates from Slack in real time">
            Live
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
