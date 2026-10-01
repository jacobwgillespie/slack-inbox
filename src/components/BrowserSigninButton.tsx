import { useState } from 'react'

export function BrowserSigninButton({ className, label = 'Sign in to Slack' }: { className?: string; label?: string }) {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string>()
  return <>
    <button className={className} disabled={waiting} onClick={async () => {
      setWaiting(true)
      setError(undefined)
      try {
        await window.slackDesktop?.signInWithBrowser()
        await window.slackDesktop?.hideSlack()
        window.dispatchEvent(new Event('desktop-slack-close'))
      } catch (error) {
        setError(error instanceof Error ? error.message : 'Browser sign-in failed. Please try again.')
      } finally {
        setWaiting(false)
      }
    }}>{waiting ? 'Waiting for browser…' : label}</button>
    {error && <span role="alert">{error}</span>}
  </>
}
