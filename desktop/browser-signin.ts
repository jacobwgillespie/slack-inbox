import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import type { Readable, Writable } from 'node:stream'
import type { Session } from 'electron'

interface ChromeCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expires: number
  sameSite?: 'Strict' | 'Lax' | 'None'
}
interface Target { targetId: string; type: string; url: string }

/** A dedicated Chrome profile handles SSO. Its DevTools pipe is private to this process. */
export class BrowserSignin {
  private running?: Promise<void>
  private cancel?: () => void

  constructor(private readonly profile: string, private readonly destination: Session) {}

  start() {
    this.running ??= this.signin().finally(() => { this.running = undefined })
    return this.running
  }

  async stop() {
    this.cancel?.()
    await this.running?.catch(() => undefined)
  }

  private async signin() {
    const executable = process.env.SLACK_SIGNIN_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    await access(executable).catch(() => { throw new Error('Install Google Chrome or set SLACK_SIGNIN_CHROME to its executable.') })
    await mkdir(this.profile, { recursive: true })
    const child = spawn(executable, [
      `--user-data-dir=${this.profile}`, '--remote-debugging-pipe', '--no-first-run',
      '--no-default-browser-check', '--new-window', 'https://slack.com/signin',
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
    const input = child.stdio[3] as Writable
    const output = child.stdio[4] as Readable
    let nextId = 0
    let closed = false
    let buffered = ''
    const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
    const close = () => {
      closed = true
      for (const request of pending.values()) request.reject(new Error('Browser sign-in was closed.'))
      pending.clear()
    }
    child.on('exit', close)
    child.on('error', close)
    input.on('error', close)
    output.on('error', close)
    output.setEncoding('utf8')
    output.on('data', (data: string) => {
      buffered += data
      let boundary: number
      while ((boundary = buffered.indexOf('\0')) !== -1) {
        const message = JSON.parse(buffered.slice(0, boundary))
        buffered = buffered.slice(boundary + 1)
        const request = pending.get(message.id)
        if (!request) continue
        pending.delete(message.id)
        if (message.error) request.reject(new Error(message.error.message))
        else request.resolve(message.result)
      }
    })
    const command = <T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> => {
      if (closed) return Promise.reject(new Error('Browser sign-in was closed.'))
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Browser sign-in did not respond.')) }, 15000)
        pending.set(id, {
          resolve: (result) => { clearTimeout(timeout); resolve(result as T) },
          reject: (error) => { clearTimeout(timeout); reject(error) },
        })
        input.write(JSON.stringify({ id, method, params, sessionId }) + '\0')
      })
    }
    this.cancel = () => { close(); child.kill() }
    try {
      const deadline = Date.now() + 20 * 60 * 1000
      while (!closed && Date.now() < deadline) {
        const { targetInfos } = await command('Target.getTargets') as { targetInfos: Target[] }
        const target = targetInfos.find((candidate) => candidate.type === 'page' &&
          /^https:\/\/app\.slack\.com\/client\/T[A-Z0-9]+(?:[/?#]|$)/.test(candidate.url))
        if (target) {
          const { sessionId } = await command<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true })
          const { cookies } = await command('Network.getCookies', { urls: ['https://slack.com/', 'https://app.slack.com/'] }, sessionId) as { cookies: ChromeCookie[] }
          const slackCookies = cookies.filter((cookie) => cookie.domain === 'slack.com' || cookie.domain === '.slack.com' || cookie.domain.endsWith('.slack.com'))
          if (slackCookies.some((cookie) => cookie.name === 'd' && cookie.value)) {
            for (const cookie of slackCookies) {
              await this.destination.cookies.set({
                url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
                name: cookie.name, value: cookie.value,
                domain: cookie.domain.startsWith('.') ? cookie.domain : undefined,
                path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
                expirationDate: cookie.expires > 0 ? cookie.expires : undefined,
                sameSite: cookie.sameSite === 'Strict' ? 'strict' : cookie.sameSite === 'Lax' ? 'lax' : cookie.sameSite === 'None' ? 'no_restriction' : 'unspecified',
              })
            }
            await this.destination.cookies.flushStore()
            await command('Browser.close').catch(() => undefined)
            return
          }
          await command('Target.detachFromTarget', { sessionId })
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      throw new Error('Browser sign-in timed out or was closed. Please try again.')
    } finally {
      this.cancel = undefined
      close()
      child.kill()
    }
  }
}
