import { AuthRequest } from 'electron-native-auth'
import type { Session } from 'electron'

interface MagicLogin { host: string; tokens: string[] }

// Slack's desktop callback carries one-time keys, not the browser's cookies.
export function parseMagicLogin(callback: string): MagicLogin[] {
  const url = new URL(callback)
  if (url.protocol !== 'slack:') throw new Error('Slack returned an unexpected sign-in link.')
  const groups: MagicLogin[] = []
  if (url.hostname === 'login-v2') {
    for (let index = 0; url.searchParams.has(`${index}.tokens`); index++) {
      if (url.searchParams.get(`${index}.dpop`) === '1') throw new Error('This workspace requires device-bound sign-in, which is not supported yet.')
      groups.push({ host: url.searchParams.get(`${index}.host`) ?? '', tokens: url.searchParams.get(`${index}.tokens`)!.split('_') })
    }
  } else {
    const match = /^slack:\/\/([TE][A-Z0-9]+)\/magic-login\/([A-Za-z0-9-]+)\/?(?:\?|$)/i.exec(callback)
    if (match) groups.push({ host: url.searchParams.get('host') ?? 'slack.com', tokens: [`z-app-${match[1]!.toUpperCase()}-${match[2]}`] })
    if (url.searchParams.get('dpop') === '1') throw new Error('This workspace requires device-bound sign-in, which is not supported yet.')
  }
  if (!groups.length || groups.some(({ host, tokens }) =>
    !/^(?:[a-z0-9-]+\.)*slack\.com$/.test(host) || !tokens.length || tokens.some((token) => !/^z-app-[TE][A-Z0-9]+-[A-Za-z0-9-]+$/.test(token)))) {
    throw new Error('Slack returned an invalid sign-in link.')
  }
  return groups
}

export class BrowserSignin {
  private running?: Promise<void>
  private request?: AuthRequest
  private abort?: AbortController

  constructor(private readonly destination: Session, private readonly windowHandle: () => Buffer) {}

  start() {
    this.running ??= this.signin().finally(() => { this.running = undefined; this.request = undefined; this.abort = undefined })
    return this.running
  }

  async stop() {
    this.request?.cancel()
    this.abort?.abort()
    await this.running?.catch(() => undefined)
  }

  private async signin() {
    if (!AuthRequest.isAvailable()) throw new Error('Browser sign-in currently requires macOS.')
    this.abort = new AbortController()
    this.request = new AuthRequest({
      url: 'https://slack.com/ssb/signin?aswebauth=1',
      callbackScheme: 'slack',
      windowHandle: this.windowHandle(),
    })
    let callback: string
    try { callback = await this.request.start() }
    catch { throw new Error('Browser sign-in was cancelled or could not complete. Please try again.') }
    finally { this.request = undefined }
    for (const { host, tokens } of parseMagicLogin(callback)) {
      const url = new URL(`https://${host}/api/auth.loginMagicBulk`)
      url.searchParams.set('magic_tokens', tokens.join(','))
      url.searchParams.set('ssb', '1')
      // Session.fetch applies Slack's Set-Cookie headers to the embedded profile.
      const response = await this.destination.fetch(url.href, { credentials: 'include', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) })
        .catch(() => { throw new Error('Could not finish connecting to Slack. Please try again.') })
      const result = await response.json() as { ok?: boolean; token_results?: Record<string, { team?: { id?: string }; auth_redir?: string }> }
      if (!response.ok || !result.ok || !Object.values(result.token_results ?? {}).some((entry) => entry.team?.id && !entry.auth_redir)) {
        throw new Error('Slack could not complete the sign-in handoff. Please sign in again.')
      }
    }
    await this.destination.cookies.flushStore()
    if (!(await this.destination.cookies.get({ name: 'd' })).some((cookie) => cookie.value)) {
      throw new Error('Slack did not establish a session. Please sign in again.')
    }
  }
}
