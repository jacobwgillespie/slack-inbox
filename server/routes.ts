import type { IncomingMessage, ServerResponse } from 'node:http'
import { SlackError } from './slack-client'
import type { SyncEngine } from './sync'

type Handler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> | void

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString()
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new RequestError(400, 'invalid_json')
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new RequestError(400, `missing_${name}`)
  return value
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function streamEvents(engine: SyncEngine): Handler {
  return (request, response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (version: number) => response.write(`data: ${JSON.stringify({ version })}\n\n`)
    send(engine.inbox().version)
    const unsubscribe = engine.subscribe(send)
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25 * 1000)
    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  }
}

export function localApi(engine: SyncEngine) {
  const routes: Record<string, Handler> = {
    'GET /local/inbox': (_, response) => sendJson(response, 200, engine.inbox()),
    'GET /local/emoji': (_, response) => sendJson(response, 200, engine.emoji()),
    'GET /local/events': streamEvents(engine),
    'GET /local/replies': async (_, response, url) => {
      const channel = requireString(url.searchParams.get('channel'), 'channel')
      const ts = requireString(url.searchParams.get('ts'), 'ts')
      sendJson(response, 200, await engine.threadReplies(channel, ts))
    },
    'POST /local/sync': (_, response) => {
      engine.requestSync()
      sendJson(response, 202, { ok: true })
    },
    'POST /local/mark': async (request, response) => {
      const body = await readJson(request)
      await engine.markRead(requireString(body.channel, 'channel'), requireString(body.ts, 'ts'))
      sendJson(response, 200, { ok: true })
    },
    'POST /local/post': async (request, response) => {
      const body = await readJson(request)
      const threadTs = typeof body.threadTs === 'string' ? body.threadTs : undefined
      await engine.postMessage(requireString(body.channel, 'channel'), requireString(body.text, 'text'), threadTs)
      sendJson(response, 200, { ok: true })
    },
  }

  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/local/')) return next()
    const handler = routes[`${request.method} ${url.pathname}`]
    if (!handler) return sendJson(response, 404, { error: { code: 'not_found', message: 'Not found' } })
    try {
      await handler(request, response, url)
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.status, { error: { code: error.code, message: error.message } })
      } else if (error instanceof SlackError) {
        sendJson(response, 502, { error: { code: error.code, needed: error.needed, message: error.message } })
      } else {
        sendJson(response, 500, { error: { code: 'internal_error', message: String(error) } })
      }
    }
  }
}
