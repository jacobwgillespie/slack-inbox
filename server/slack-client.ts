import type { CredentialMode } from '../src/slack/types'

const CONCURRENCY_PER_METHOD = 4
const DEFAULT_RETRY_SECONDS = 5

export interface SlackCredentials {
  origin: string
  userToken?: string
  sessionToken?: string
  sessionCookie?: string
}

export function credentialMode(credentials: SlackCredentials): CredentialMode {
  if (credentials.sessionToken) return 'session'
  if (credentials.userToken) return 'user'
  return 'none'
}

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly needed?: string,
  ) {
    super(`${method} failed: ${code}`)
  }
}

export type Params = Record<string, string | number | boolean | undefined>

interface SlackResponse {
  ok: boolean
  error?: string
  needed?: string
  response_metadata?: { next_cursor?: string }
}

class Semaphore {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async acquire() {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  release() {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export class SlackClient {
  private readonly semaphores = new Map<string, Semaphore>()
  private readonly pausedUntil = new Map<string, number>()

  constructor(private readonly credentials: SlackCredentials) {}

  async call<T>(method: string, params: Params = {}): Promise<T> {
    const semaphore = this.semaphoreFor(method)
    for (;;) {
      await this.waitForRateLimit(method)
      await semaphore.acquire()
      let response: Response
      try {
        response = await this.send(method, params)
      } finally {
        semaphore.release()
      }
      if (response.status === 429) {
        const seconds = Number(response.headers.get('Retry-After')) || DEFAULT_RETRY_SECONDS
        this.pausedUntil.set(method, Math.max(this.pausedUntil.get(method) ?? 0, Date.now() + seconds * 1000))
        continue
      }
      const data: SlackResponse = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }))
      if (!data.ok) throw new SlackError(method, data.error ?? 'unknown_error', data.needed)
      return data as T
    }
  }

  async paginate<T>(method: string, key: string, params: Params = {}): Promise<T[]> {
    const results: T[] = []
    let cursor: string | undefined
    do {
      const page = await this.call<SlackResponse & Record<string, unknown>>(method, { ...params, cursor })
      results.push(...((page[key] as T[] | undefined) ?? []))
      cursor = page.response_metadata?.next_cursor || undefined
    } while (cursor)
    return results
  }

  realtimeHeaders(): Record<string, string> {
    const { sessionToken, sessionCookie } = this.credentials
    return sessionToken && sessionCookie ? { cookie: `d=${sessionCookie}` } : {}
  }

  private send(method: string, params: Params): Promise<Response> {
    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, String(value))
    }
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    const { sessionToken, sessionCookie, userToken, origin } = this.credentials
    if (sessionToken) {
      body.set('token', sessionToken)
      if (sessionCookie) headers.cookie = `d=${sessionCookie}`
    } else if (userToken) {
      headers.authorization = `Bearer ${userToken}`
    }
    return fetch(`${origin}/api/${method}`, { method: 'POST', headers, body })
  }

  private semaphoreFor(method: string) {
    let semaphore = this.semaphores.get(method)
    if (!semaphore) {
      semaphore = new Semaphore(CONCURRENCY_PER_METHOD)
      this.semaphores.set(method, semaphore)
    }
    return semaphore
  }

  private async waitForRateLimit(method: string) {
    for (;;) {
      const remaining = (this.pausedUntil.get(method) ?? 0) - Date.now()
      if (remaining <= 0) return
      await wait(remaining)
    }
  }
}
