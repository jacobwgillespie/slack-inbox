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
  const scanning = useStore((state) => state.scanning)
  const progress = useStore((state) => state.scanProgress)
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
        {scanning && (
          <span className="scan-status">
            {progress.total ? `Checking ${progress.done} of ${progress.total}` : 'Checking conversations'}
          </span>
        )}
        <button
          className={`icon-button${scanning ? ' spinning' : ''}`}
          onClick={() => void refresh()}
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
