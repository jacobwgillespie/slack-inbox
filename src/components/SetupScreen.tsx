import { BrowserSigninButton } from './BrowserSigninButton'
import { useStore } from '../store'

const AUTH_ERRORS = new Set(['session_not_ready', 'not_authed', 'invalid_auth', 'token_revoked', 'token_expired', 'account_inactive'])

export function SetupScreen() {
  const error = useStore((state) => state.error)
  const refresh = useStore((state) => state.refresh)
  const needsSignIn = error !== undefined && AUTH_ERRORS.has(error.code)

  return (
    <main className="setup">
      <div className="setup-content">
        <img className="setup-app-icon" src="/icon.png" alt="" />
        <h1>{needsSignIn ? 'Welcome to Slack Inbox' : 'Could not connect to Slack'}</h1>
        {needsSignIn ? <p className="setup-intro">A calmer place for your conversations.<br />Read, save for later, and clear what’s handled.</p> : <p className="setup-intro">Please try connecting again.</p>}
        {!needsSignIn && error && <p role="alert" className="setup-error">{error.message}</p>}
        {needsSignIn ? <div className="setup-actions">
          <BrowserSigninButton className="onboarding-start" />
        </div> : <button className="onboarding-start" onClick={refresh}>Try again</button>}
      </div>
    </main>
  )
}
