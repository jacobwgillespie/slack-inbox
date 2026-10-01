import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import type { Session } from 'electron'
import { SlackClient, SlackError, type SlackCredentials } from '../server/slack-client.ts'

/** Reuse the session explicitly configured for this project's browser app. */
export async function configuredSession(root: string, destination: Session, credentials: SlackCredentials) {
  const text = await readFile(join(root, '.env.local'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const env = parseEnv(text)
  const token = process.env.SLACK_SESSION_TOKEN || env.SLACK_SESSION_TOKEN
  const cookie = process.env.SLACK_SESSION_COOKIE || env.SLACK_SESSION_COOKIE
  if (!token || !cookie) return undefined
  const existing = { origin: 'https://slack.com', sessionToken: token, sessionCookie: cookie }
  try {
    const auth = await new SlackClient(existing).call<{ team_id: string }>('auth.test')
    await destination.cookies.set({
      url: 'https://slack.com/', name: 'd', value: cookie,
      domain: '.slack.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction',
    })
    await destination.cookies.flushStore()
    credentials.sessionToken = token
    return auth.team_id
  } catch (error) {
    if (error instanceof SlackError) {
      console.warn(`Configured Slack session unavailable: ${error.code}`)
      return undefined
    }
    throw error
  }
}
