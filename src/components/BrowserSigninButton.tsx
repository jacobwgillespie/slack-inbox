import { useEffect, useRef, useState } from 'react'

export function BrowserSigninButton({ className, label = 'Sign in to Slack' }: { className?: string; label?: string }) {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string>()
  const [showRetry, setShowRetry] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const currentAttempt = useRef(0)

  useEffect(() => {
    if (!waiting) return
    const timer = setTimeout(() => setShowRetry(true), 10_000)
    return () => clearTimeout(timer)
  }, [waiting, attempt])

  async function signIn(restart = false) {
    const id = ++currentAttempt.current
    setAttempt(id)
    setWaiting(true)
    setShowRetry(false)
    setError(undefined)
    try {
      await window.slackDesktop.signInWithBrowser(restart)
      if (id !== currentAttempt.current) return
      await window.slackDesktop.hideSlack()
      window.dispatchEvent(new Event('desktop-slack-close'))
    } catch (error) {
      if (id !== currentAttempt.current) return
      setError(error instanceof Error ? error.message : 'Browser sign-in failed. Please try again.')
      setShowRetry(true)
    } finally {
      if (id === currentAttempt.current) setWaiting(false)
    }
  }

  return <>
    <button className={className} disabled={waiting} onClick={() => void signIn()}>{waiting ? 'Waiting for browser…' : label}</button>
    {showRetry && <p className="signin-retry">Having trouble? <button onClick={() => void signIn(true)}>Retry connection</button></p>}
    {error && <span role="alert">{error}</span>}
  </>
}
