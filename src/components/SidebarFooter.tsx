import { useRef, useState } from 'react'
import { openDesktopSlack } from '../desktop'
import { useStore } from '../store'
import { Avatar } from './Avatar'
import { ExternalIcon, HelpIcon, LogoutIcon, RefreshIcon } from './Icons'

export function SidebarFooter() {
  const session = useStore((state) => state.session)
  const self = useStore((state) => state.session ? state.users[state.session.userId] : undefined)
  const scanning = useStore((state) => Boolean(state.sync?.running))
  const refresh = useStore((state) => state.refresh)
  const toggleHelp = useStore((state) => state.toggleHelp)
  const menu = useRef<HTMLDivElement>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string>()

  const logOut = async () => {
    setLoggingOut(true)
    setError(undefined)
    try {
      await window.slackDesktop!.logOut()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not log out. Please try again.')
      setLoggingOut(false)
    }
  }

  return (
    <footer className="sidebar-footer">
      <button className="account-button" popoverTarget="account-menu" aria-label="Open account menu" title={self?.displayName || session?.handle || 'Account'}>
        <Avatar url={self?.avatar} name={self?.displayName || session?.handle || 'You'} />
      </button>
      <div ref={menu} id="account-menu" className="account-menu" popover="auto" aria-label="Account">
        <button onClick={() => { menu.current?.hidePopover(); toggleHelp() }}>
          <HelpIcon /><span>Help</span><kbd>?</kbd>
        </button>
        {window.slackDesktop && <>
          <hr />
          <button onClick={() => void logOut()} disabled={loggingOut}>
            <LogoutIcon /><span>{loggingOut ? 'Logging out…' : 'Log out'}</span>
          </button>
          {error && <p role="alert" className="account-error">{error}</p>}
        </>}
      </div>
      {session ? (
        <a className="workspace-link" href={session.url} target="_blank" rel="noreferrer" onClick={(event) => { if (openDesktopSlack()) event.preventDefault() }}>
          <span>Open Slack</span><ExternalIcon />
        </a>
      ) : <span className="workspace-link">Slack Inbox</span>}
      <button className={`icon-button${scanning ? ' spinning' : ''}`} onClick={refresh} disabled={scanning} title="Refresh (Shift+R)" aria-label="Refresh">
        <RefreshIcon />
      </button>
    </footer>
  )
}
