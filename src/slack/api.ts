const CONCURRENCY = 8
const MAX_ATTEMPTS = 6

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

let active = 0
const waiting: (() => void)[] = []

async function acquire() {
  if (active < CONCURRENCY) {
    active++
    return
  }
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else active--
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function call<T>(method: string, params: Params = {}): Promise<T> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.set(key, String(value))
  }

  await acquire()
  try {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`/api/${method}`, { method: 'POST', body })
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        await wait(Number(response.headers.get('Retry-After') ?? '1') * 1000)
        continue
      }
      const data: SlackResponse = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }))
      if (!data.ok) throw new SlackError(method, data.error ?? 'unknown_error', data.needed)
      return data as T
    }
  } finally {
    release()
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
