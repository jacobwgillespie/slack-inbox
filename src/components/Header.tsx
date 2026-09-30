import { useViewCounts } from '../hooks'
import { useStore, VIEWS, type View } from '../store'
import { RefreshIcon } from './Icons'

const VIEW_LABELS: Record<View, string> = {
  important: 'Important',
  other: 'Other',
  later: 'Later',
  muted: 'Muted',
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
      <div className="brand">Inbox</div>
      <nav className="tabs" aria-label="Views">
        {VIEWS.map((candidate, index) => (
          <button
            key={candidate}
            className={`tab${candidate === view ? ' active' : ''}`}
            onClick={() => setView(candidate)}
            title={`${index + 1}`}
          >
            {VIEW_LABELS[candidate]}
            <span className="tab-count">{counts[candidate]}</span>
          </button>
        ))}
      </nav>
      <div className="header-tools">
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
        <button
          className={`icon-button${scanning ? ' spinning' : ''}`}
          onClick={refresh}
          disabled={scanning}
          title="Refresh (Shift+R)"
        >
          <RefreshIcon />
        </button>
        <button className="icon-button" onClick={toggleHelp} title="Keyboard shortcuts (?)">
          ?
        </button>
      </div>
    </header>
  )
}
