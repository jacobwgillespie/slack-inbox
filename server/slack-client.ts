const CONCURRENCY_PER_METHOD = 4
const DEFAULT_RETRY_SECONDS = 5

export interface SlackCredentials {
  origin: string
  sessionToken?: string
  sessionCookie?: string
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

  constructor(
    private readonly credentials: SlackCredentials,
    private readonly fetchRequest: typeof fetch = fetch,
  ) {}

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

  async downloadFile(source: string): Promise<Response> {
    let url = new URL(source)
    for (let redirects = 0; redirects < 5; redirects++) {
      const slackHost = url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com')
      const slackCdn = url.hostname.endsWith('.slack-edge.com') || url.hostname.endsWith('.slack-files.com')
      if (url.protocol !== 'https:' || url.username || url.password || (!slackHost && !slackCdn)) {
        throw new SlackError('files.download', 'invalid_file_host')
      }
      const headers: Record<string, string> = {}
      if (slackHost) {
        const { sessionToken, sessionCookie } = this.credentials
        headers.authorization = `Bearer ${sessionToken ?? ''}`
        if (sessionToken && sessionCookie) headers.cookie = `d=${sessionCookie}`
      }
      const response = await this.fetchRequest(url, { headers, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        url = new URL(response.headers.get('location')!, url)
        await response.body?.cancel()
        continue
      }
      if (!response.ok) throw new SlackError('files.download', `http_${response.status}`)
      return response
    }
    throw new SlackError('files.download', 'too_many_redirects')
  }

  async uploadImage(filename: string, data: Uint8Array, contentType: string): Promise<string> {
    const result = await this.call<{ upload_url: string; file_id: string }>('files.getUploadURLExternal', { filename, length: data.length })
    const url = new URL(result.upload_url)
    if (url.protocol !== 'https:' || !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))) throw new SlackError('files.upload', 'invalid_upload_host')
    const response = await this.fetchRequest(url, { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(data) })
    if (!response.ok) throw new SlackError('files.upload', `http_${response.status}`)
    await response.body?.cancel()
    return result.file_id
  }

  private send(method: string, params: Params): Promise<Response> {
    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, String(value))
    }
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    const { sessionToken, sessionCookie, origin } = this.credentials
    if (sessionToken) {
      body.set('token', sessionToken)
      if (sessionCookie) headers.cookie = `d=${sessionCookie}`
    }
    return this.fetchRequest(`${origin}/api/${method}`, { method: 'POST', headers, body })
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
