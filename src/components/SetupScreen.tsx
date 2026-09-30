import { useStore } from '../store'

const AUTH_ERRORS = new Set(['not_authed', 'invalid_auth', 'token_revoked', 'token_expired', 'account_inactive'])

export function SetupScreen() {
  const error = useStore((state) => state.error)
  const refresh = useStore((state) => state.refresh)
  const needsToken = error !== undefined && AUTH_ERRORS.has(error.code)

  return (
    <main className="setup">
      <h1>{needsToken ? 'Connect Slack' : 'Could not load Slack'}</h1>
      {error && <p className="setup-error">{error.message}</p>}
      {error?.needed && (
        <p>
          The token is missing the <code>{error.needed}</code> scope. Add it to the Slack app and reinstall the app.
        </p>
      )}
      <ol>
        <li>
          Go to <a href="https://api.slack.com/apps?new_app=1">api.slack.com/apps</a> and create an app from a manifest.
          Use the contents of <code>slack-app-manifest.json</code>.
        </li>
        <li>Install the app to your workspace.</li>
        <li>
          Copy the User OAuth Token (it starts with <code>xoxp-</code>) into <code>.env.local</code> as{' '}
          <code>SLACK_USER_TOKEN</code>.
        </li>
        <li>Restart the development server.</li>
      </ol>
      <button className="button primary" onClick={refresh}>
        Try again
      </button>
    </main>
  )
}
