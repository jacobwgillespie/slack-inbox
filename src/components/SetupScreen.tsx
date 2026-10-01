import { BrowserSigninButton } from './BrowserSigninButton'
import { useStore } from '../store'

const AUTH_ERRORS = new Set(['not_authed', 'invalid_auth', 'token_revoked', 'token_expired', 'account_inactive'])

export function SetupScreen() {
  const error = useStore((state) => state.error)
  const refresh = useStore((state) => state.refresh)
  const needsToken = error !== undefined && AUTH_ERRORS.has(error.code)

  return (
    <main className="setup">
      <div className="setup-content">
        <img className="setup-app-icon" src="/icon.png" alt="" />
        <h1>{needsToken ? 'Welcome to Slack Inbox' : 'Could not connect to Slack'}</h1>
        {needsToken ? <p className="setup-intro">A calmer place for your conversations.<br />Read, save for later, and clear what’s handled.</p> : <p className="setup-intro">Please try connecting again.</p>}
        {!needsToken && error && <p role="alert" className="setup-error">{error.message}</p>}
        {error?.needed && <p>The token is missing the <code>{error.needed}</code> scope. Add it to the Slack app and reinstall the app.</p>}
        {window.slackDesktop && needsToken ? <div className="setup-actions">
          <BrowserSigninButton className="onboarding-start" />
          <span className="setup-signin-note">Continue in your browser, then return here.</span>
        </div> : needsToken ? <ol>
          <li>Go to <a href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</a> and create an app from <code>slack-app-manifest.json</code>.</li>
          <li>Install the app to your workspace.</li>
          <li>Add the User OAuth Token to <code>.env.local</code> as <code>SLACK_USER_TOKEN</code>.</li>
          <li>Restart the development server.</li>
        </ol> : <button className="onboarding-start" onClick={refresh}>Try again</button>}
      </div>
    </main>
  )
}
