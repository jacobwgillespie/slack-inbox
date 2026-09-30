const CONCURRENCY_PER_METHOD = 4
const DEFAULT_RETRY_SECONDS = 5

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly needed?: string,
  ) {
    super(`${method} failed: ${code}`)
  }
}

type Params = Record<string, string | number | boolean | undefined>

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

const semaphores = new Map<string, Semaphore>()
const pausedUntil = new Map<string, number>()

function semaphoreFor(method: string) {
  let semaphore = semaphores.get(method)
  if (!semaphore) {
    semaphore = new Semaphore(CONCURRENCY_PER_METHOD)
    semaphores.set(method, semaphore)
  }
  return semaphore
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitForRateLimit(method: string) {
  for (;;) {
    const remaining = (pausedUntil.get(method) ?? 0) - Date.now()
    if (remaining <= 0) return
    await wait(remaining)
  }
}

export async function call<T>(method: string, params: Params = {}): Promise<T> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, String(value))
  }

  const semaphore = semaphoreFor(method)
  for (;;) {
    await waitForRateLimit(method)
    await semaphore.acquire()
    let response: Response
    try {
      response = await fetch(`/api/${method}`, { method: 'POST', body })
    } finally {
      semaphore.release()
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After')) || DEFAULT_RETRY_SECONDS
      pausedUntil.set(method, Math.max(pausedUntil.get(method) ?? 0, Date.now() + seconds * 1000))
      continue
    }
    const data: SlackResponse = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }))
    if (!data.ok) throw new SlackError(method, data.error ?? 'unknown_error', data.needed)
    return data as T
  }
}

export async function paginate<T>(method: string, key: string, params: Params = {}): Promise<T[]> {
  const results: T[] = []
  let cursor: string | undefined
  do {
    const page = await call<SlackResponse & Record<string, unknown>>(method, { ...params, cursor })
    results.push(...((page[key] as T[] | undefined) ?? []))
    cursor = page.response_metadata?.next_cursor || undefined
  } while (cursor)
  return results
}
