import { useState } from 'react'

export function BrowserSigninButton() {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string>()
  return <>
    <button disabled={waiting} onClick={async () => {
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
    }}>{waiting ? 'Complete sign-in in Chrome…' : 'Sign in with Chrome / passkey'}</button>
    {error && <span role="alert">{error}</span>}
  </>
}
