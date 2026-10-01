import { useStore } from '../store'
import { BrowserSigninButton } from './BrowserSigninButton'
import { useEffect, useState } from 'react'

export function DesktopSlack() {
  const status = useStore((state) => state.status)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const show = () => setVisible(true)
    const hide = () => setVisible(false)
    window.addEventListener('desktop-slack-open', show)
    window.addEventListener('desktop-slack-close', hide)
    return () => {
      window.removeEventListener('desktop-slack-open', show)
      window.removeEventListener('desktop-slack-close', hide)
    }
  }, [])
  if (!visible) return null
  return <div className="desktop-slack-toolbar">
    <button onClick={() => {
      void window.slackDesktop.hideSlack().then(() => setVisible(false))
    }}>← Back to Inbox</button>
    <span>Slack</span>
    {status === 'error' && <BrowserSigninButton />}
  </div>
}
