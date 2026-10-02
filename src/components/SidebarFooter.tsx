import { useRuntime, useUsers } from '../data'
import { commands } from '../commands'
import { useEffect, useRef, useState } from 'react'
import { openDesktopSlack } from '../desktop'
import { Avatar } from './Avatar'
import { PresenceDot } from './PresenceDot'
import { usePresence } from '../presence'
import { useStore } from '../store'
import { localApi } from '../api'
import { presenceCollection, userCollection, reconcile } from '../collections'
import { renderEmoji } from '../format'
import { useFormatContext } from '../hooks'
import { useCustomStatus } from '../custom-status'
import { StatusEditor } from './StatusEditor'
import { BugIcon, CloseIcon, DownloadIcon, HelpIcon, LogoutIcon, PresenceIcon, ReactionIcon, RefreshIcon, SearchIcon, ThreadIcon } from './Icons'

export function SidebarFooter({ onWelcome }: { onWelcome: () => void }) {
  const session = useRuntime().session
  const users = useUsers()
  const self = session ? users[session.userId] : undefined
  const context = useFormatContext()
  const [editingStatus, setEditingStatus] = useState(false)
  const [clearingStatus, setClearingStatus] = useState(false)
  const hasStatus = useCustomStatus(self)
  const presence = usePresence(session?.userId)
  const [settingPresence, setSettingPresence] = useState(false)
  const refreshing = useStore((state) => state.refreshing)
  const refresh = commands.refresh
  const toggleHelp = commands.toggleHelp
  const menu = useRef<HTMLDivElement>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string>()
  const [updateVersion, setUpdateVersion] = useState<string>()
  const [restarting, setRestarting] = useState(false)

  const clearStatus = async () => {
    setClearingStatus(true)
    setError(undefined)
    try {
      const result = await localApi.setCustomStatus('', '', 0)
      reconcile(userCollection, [result.user], false)
      menu.current?.hidePopover()
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not clear your status.') }
    finally { setClearingStatus(false) }
  }

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

  const setPresence = async (value: 'auto' | 'away') => {
    if (!session) return
    setSettingPresence(true)
    setError(undefined)
    try {
      const result = await localApi.setPresence(value)
      reconcile(presenceCollection, [{ id: session.userId, presence: result.presence }], false)
      menu.current?.hidePopover()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not change your presence.')
    } finally { setSettingPresence(false) }
  }

  return (
    <footer className="sidebar-footer">
      <button className="account-button" popoverTarget="account-menu" aria-label="Open account menu" title={self?.displayName || session?.handle || 'Account'}>
        <Avatar url={self?.avatar} name={self?.displayName || session?.handle || 'You'} />
        {hasStatus && <span className="account-status" role="img" aria-label={self?.statusText || 'Custom status'} title={self?.statusText || 'Custom status'}>
          {renderEmoji(self?.statusEmoji?.replace(/^:|:$/g, '') || 'speech_balloon', context)}
        </span>}
        <PresenceDot presence={presence} />
      </button>
      <div ref={menu} id="account-menu" className="account-menu" popover="auto" aria-label="Account">
        {session && <>
          <button onClick={() => { menu.current?.hidePopover(); setEditingStatus(true) }}>
            {hasStatus ? renderEmoji(self?.statusEmoji?.replace(/^:|:$/g, '') || 'speech_balloon', context) : <ReactionIcon />}
            <span className="account-status-label">{hasStatus ? self?.statusText || 'Edit status' : 'Set a status'}</span>
          </button>
          {hasStatus && <button onClick={() => void clearStatus()} disabled={clearingStatus}><CloseIcon /><span>{clearingStatus ? 'Clearing…' : 'Clear status'}</span></button>}
          {presence && <button onClick={() => void setPresence(presence === 'active' ? 'away' : 'auto')} disabled={settingPresence}>
            <PresenceIcon active={presence !== 'active'} /><span>Set yourself {presence === 'active' ? 'away' : 'active'}</span>
          </button>}
          <hr />
        </>}
        <button onClick={() => { menu.current?.hidePopover(); onWelcome() }}>
          <ThreadIcon /><span>Welcome</span>
        </button>
        <button onClick={() => { menu.current?.hidePopover(); toggleHelp() }}>
          <HelpIcon /><span>Help</span><kbd>?</kbd>
        </button>
        <button className={refreshing ? 'spinning' : undefined} onClick={() => { menu.current?.hidePopover(); refresh() }} disabled={refreshing}>
          <RefreshIcon /><span>{refreshing ? 'Refreshing…' : 'Refresh'}</span><kbd>⇧R</kbd>
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
      {editingStatus && self && <StatusEditor user={self} onClose={() => setEditingStatus(false)} />}
      <div className="sidebar-footer-actions">
        {updateVersion && <button className="icon-button update-button" onClick={() => void installUpdate()} disabled={restarting}
          title={`Restart to update to ${updateVersion}`} aria-label={restarting ? 'Restarting to update' : `Restart to update to ${updateVersion}`}>
          <DownloadIcon />
        </button>}
        <button className="icon-button" onClick={() => commands.setSearchOpen(true)} title="Search threads (/)" aria-label="Search threads">
          <SearchIcon />
        </button>
      </div>
    </footer>
  )
}
