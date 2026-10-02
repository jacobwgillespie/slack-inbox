import { useRuntime, useUsers } from '../data'
import { commands } from '../commands'
import { useEffect, useRef, useState } from 'react'
import { openDesktopSlack } from '../desktop'
import { Avatar } from './Avatar'
import { BugIcon, DownloadIcon, HelpIcon, LogoutIcon, RefreshIcon, ThreadIcon } from './Icons'

export function SidebarFooter({ onWelcome }: { onWelcome: () => void }) {
  const session = useRuntime().session
  const users = useUsers()
  const self = session ? users[session.userId] : undefined
  const scanning = Boolean(useRuntime().sync?.running)
  const refresh = commands.refresh
  const toggleHelp = commands.toggleHelp
  const menu = useRef<HTMLDivElement>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string>()
  const [updateVersion, setUpdateVersion] = useState<string>()
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    const desktop = window.slackDesktop
    const unsubscribe = desktop.onUpdateReady(setUpdateVersion)
    void desktop.updateVersion().then(setUpdateVersion).catch((error) => console.warn('Could not read update state', error))
    return unsubscribe
  }, [])

  const installUpdate = async () => {
    setRestarting(true)
    try { await window.slackDesktop.installUpdate() }
    catch (error) {
      console.warn('Could not restart to update', error)
      setRestarting(false)
    }
  }

  const logOut = async () => {
    setLoggingOut(true)
    setError(undefined)
    try {
      await window.slackDesktop.logOut()
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
        <button onClick={() => { menu.current?.hidePopover(); onWelcome() }}>
          <ThreadIcon /><span>Welcome</span>
        </button>
        <button onClick={() => { menu.current?.hidePopover(); toggleHelp() }}>
          <HelpIcon /><span>Help</span><kbd>?</kbd>
        </button>
        {session && <button onClick={() => {
          menu.current?.hidePopover()
          openDesktopSlack()
        }}>
          <BugIcon /><span>Debug in Slack</span>
        </button>}
        <hr />
        <button onClick={() => void logOut()} disabled={loggingOut}>
          <LogoutIcon /><span>{loggingOut ? 'Logging out…' : 'Log out'}</span>
        </button>
        {error && <p role="alert" className="account-error">{error}</p>}
      </div>
      <div className="sidebar-footer-actions">
        {updateVersion && <button className="icon-button update-button" onClick={() => void installUpdate()} disabled={restarting}
          title={`Restart to update to ${updateVersion}`} aria-label={restarting ? 'Restarting to update' : `Restart to update to ${updateVersion}`}>
          <DownloadIcon />
        </button>}
        <button className={`icon-button${scanning ? ' spinning' : ''}`} onClick={refresh} disabled={scanning} title="Refresh (Shift+R)" aria-label="Refresh">
          <RefreshIcon />
        </button>
      </div>
    </footer>
  )
}
