import { useCacheSync } from './useCachedConversation'
import { DesktopSlack } from './components/DesktopSlack'
import { openDesktopSlack } from './desktop'
import { Avatar } from './components/Avatar'
import { Detail } from './components/Detail'
import { Header } from './components/Header'
import { HelpOverlay } from './components/HelpOverlay'
import { ExternalIcon } from './components/Icons'
import { ItemList } from './components/ItemList'
import { SetupScreen } from './components/SetupScreen'
import { Toast } from './components/Toast'
import { useInboxSync, useKeyboardShortcuts, useSelectionRepair } from './hooks'
import { useStore } from './store'

export function App() {
  const status = useStore((state) => state.status)
  const helpOpen = useStore((state) => state.helpOpen)
  const session = useStore((state) => state.session)
  const self = useStore((state) => (state.session ? state.users[state.session.userId] : undefined))
  useCacheSync()
  useInboxSync()
  useKeyboardShortcuts()
  useSelectionRepair()

  if (status === 'error') return <><DesktopSlack /><SetupScreen /></>

  return (
    <div className="app">
      <DesktopSlack />
      <main className="workspace">
        <aside className="sidebar" aria-label="Inbox sidebar">
          <Header />
          <ItemList />
          <footer className="sidebar-footer">
            <Avatar url={self?.avatar} name={self?.displayName || session?.handle || 'You'} />
            {session ? (
              <a className="workspace-link" href={session.url} target="_blank" rel="noreferrer" onClick={(event) => { if (openDesktopSlack()) event.preventDefault() }}>
                <span>Open Slack</span>
                <ExternalIcon />
              </a>
            ) : (
              <span className="workspace-link">Slack Inbox</span>
            )}
          </footer>
        </aside>
        <Detail />
      </main>
      <Toast />
      {helpOpen && <HelpOverlay />}
    </div>
  )
}
