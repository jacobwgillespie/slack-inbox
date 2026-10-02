import type { OutgoingMessage, RichTextBlock } from '../src/slack/rich-text.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SlackError } from './slack-client.ts'
import type { Classification, LegacyPreferences, SlackFile } from '../src/slack/types.ts'
import type { SyncEngine } from './sync.ts'

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

function readReference(body: Record<string, unknown>) {
  return [requireString(body.channel, 'channel'), requireString(body.ts, 'ts')] as const
}

function readClassification(value: unknown): Classification | null {
  if (!value || typeof value !== 'object') return null
  const { label, reason, source } = value as Record<string, unknown>
  if ((label !== 'important' && label !== 'other') || (source !== 'model' && source !== 'user')) {
    throw new RequestError(400, 'invalid_classification')
  }
  return { label, reason: typeof reason === 'string' ? reason : '', source }
}

function readLegacyPreferences(body: Record<string, unknown>): LegacyPreferences {
  const later = Array.isArray(body.later) ? body.later : []
  const muted = Array.isArray(body.muted) ? body.muted : []
  return {
    later: later.map((entry: Record<string, unknown>) => ({
      channel: requireString(entry?.channel, 'channel'),
      ts: requireString(entry?.ts, 'ts'),
    })),
    muted: muted.map((channel) => requireString(channel, 'channel')),
  }
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
    const unsubscribeTyping = engine.subscribeTyping((event) => response.write(`event: typing\ndata: ${JSON.stringify(event)}\n\n`))
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 25 * 1000)
    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      unsubscribeTyping()
    })
  }
}

export function localApi(engine: SyncEngine) {
  const routes: Record<string, Handler> = {
    'POST /local/status': async (request, response) => {
      const body = await readJson(request)
      if (typeof body.text !== 'string' || body.text.length > 100 || typeof body.emoji !== 'string' ||
          !(body.emoji === '' || /^:[a-z0-9_+\-]+(?:::skin-tone-[2-6])?:$/i.test(body.emoji)) ||
          typeof body.expiration !== 'number' || !Number.isSafeInteger(body.expiration) || body.expiration < 0) {
        throw new RequestError(400, 'invalid_status')
      }
      const user = await engine.setCustomStatus(body.text, body.emoji, body.expiration)
      sendJson(response, 200, { user })
    },
    'GET /local/presence': async (_, response, url) => {
      const result = await engine.presence(requireString(url.searchParams.get('user'), 'user'))
      sendJson(response, 200, { presence: result.presence })
    },
    'POST /local/presence': async (request, response) => {
      const body = await readJson(request)
      if (body.presence !== 'auto' && body.presence !== 'away') throw new RequestError(400, 'invalid_presence')
      const result = await engine.setPresence(body.presence)
      sendJson(response, 200, { presence: result.presence })
    },
    'GET /local/inbox': (_, response) => sendJson(response, 200, engine.inbox()),
    'GET /local/emoji': (_, response) => sendJson(response, 200, engine.emoji()),
    'GET /local/image': async (_, response, url) => {
      const image = await engine.imagePreview(requireString(url.searchParams.get('file'), 'file'))
      response.writeHead(200, {
        'content-type': image.contentType,
        'content-length': image.data.byteLength,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      })
      response.end(image.data)
    },
    'GET /local/events': streamEvents(engine),
    'GET /local/replies': async (_, response, url) => {
      const channel = requireString(url.searchParams.get('channel'), 'channel')
      const ts = requireString(url.searchParams.get('ts'), 'ts')
      sendJson(response, 200, await engine.threadReplies(channel, ts))
    },
    'POST /local/sync': async (_, response) => {
      await engine.refresh()
      sendJson(response, 200, { ok: true })
    },
    'POST /local/done': async (request, response) => {
      const body = await readJson(request)
      const ts = body.ts == null ? undefined : requireString(body.ts, 'ts')
      if (ts !== undefined && !/^(0|\d+\.\d+)$/.test(ts)) throw new RequestError(400, 'invalid_ts')
      await engine.setDone(requireString(body.channel, 'channel'), ts, body.markRead !== false)
      sendJson(response, 200, { ok: true })
    },
    'POST /local/mark': async (request, response) => {
      const body = await readJson(request)
      await engine.markRead(requireString(body.channel, 'channel'), requireString(body.ts, 'ts'))
      sendJson(response, 200, { ok: true })
    },
    'POST /local/classifications': async (request, response) => {
      const body = await readJson(request)
      if (body.label !== 'important' && body.label !== 'other') throw new RequestError(400, 'invalid_label')
      const references = Array.isArray(body.messages) ? body.messages.map(readReference) : []
      engine.setClassifications(
        references.map(([channel, ts]) => ({ channel, ts })),
        body.label,
      )
      sendJson(response, 200, { ok: true })
    },
    'POST /local/classifications/restore': async (request, response) => {
      const body = await readJson(request)
      const entries = Array.isArray(body.entries) ? body.entries : []
      engine.restoreClassifications(
        entries.map((entry: Record<string, unknown>) => {
          const [channel, ts] = readReference(entry)
          return { channel, ts, classification: readClassification(entry.classification) }
        }),
      )
      sendJson(response, 200, { ok: true })
    },
    'POST /local/thread/mark': async (request, response) => {
      const body = await readJson(request)
      await engine.markThreadRead(
        requireString(body.channel, 'channel'),
        requireString(body.threadTs, 'threadTs'),
        requireString(body.ts, 'ts'),
      )
      sendJson(response, 200, { ok: true })
    },
    'POST /local/later': async (request, response) => {
      sendJson(response, 200, await engine.saveForLater(...readReference(await readJson(request))))
    },
    'GET /local/reactions': async (_, response, url) => {
      const channel = requireString(url.searchParams.get('channel'), 'channel')
      const ts = requireString(url.searchParams.get('ts'), 'ts')
      sendJson(response, 200, await engine.reactionDetails(channel, ts))
    },
    'POST /local/reaction': async (request, response) => {
      const body = await readJson(request)
      const [channel, ts] = readReference(body)
      sendJson(response, 200, await engine.addReaction(channel, ts, requireString(body.name, 'name')))
    },
    'POST /local/reaction/remove': async (request, response) => {
      const body = await readJson(request)
      const [channel, ts] = readReference(body)
      sendJson(response, 200, await engine.removeReaction(channel, ts, requireString(body.name, 'name')))
    },
    'POST /local/later/complete': async (request, response) => {
      await engine.completeLater(...readReference(await readJson(request)))
      sendJson(response, 200, { ok: true })
    },
    'POST /local/later/reopen': async (request, response) => {
      await engine.reopenLater(...readReference(await readJson(request)))
      sendJson(response, 200, { ok: true })
    },
    'POST /local/later/remove': async (request, response) => {
      await engine.removeLater(...readReference(await readJson(request)))
      sendJson(response, 200, { ok: true })
    },
    'POST /local/inbox-mute': async (request, response) => {
      const body = await readJson(request)
      if (typeof body.muted !== 'boolean') throw new RequestError(400, 'missing_muted')
      engine.setInboxMuted(requireString(body.channel, 'channel'), body.muted)
      sendJson(response, 200, { ok: true })
    },
    'POST /local/mute': async (request, response) => {
      const body = await readJson(request)
      if (typeof body.muted !== 'boolean') throw new RequestError(400, 'missing_muted')
      await engine.setMuted(requireString(body.channel, 'channel'), body.muted)
      sendJson(response, 200, { ok: true })
    },
    'POST /local/import': async (request, response) => {
      await engine.importLegacyPreferences(readLegacyPreferences(await readJson(request)))
      sendJson(response, 200, { ok: true })
    },
    'POST /local/upload-image': async (request, response, url) => {
      const type = request.headers['content-type']?.split(';')[0] ?? ''
      if (!type.startsWith('image/')) throw new RequestError(400, 'invalid_image_type')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 50 * 1024 * 1024) throw new RequestError(413, 'image_too_large')
        chunks.push(chunk as Buffer)
      }
      if (!size) throw new RequestError(400, 'empty_image')
      const file = await engine.uploadImage(requireString(url.searchParams.get('name'), 'filename'), Buffer.concat(chunks), type)
      sendJson(response, 200, file)
    },
    'POST /local/message/edit': async (request, response) => {
      const body = await readJson(request)
      if (typeof body.text !== 'string') throw new RequestError(400, 'missing_text')
      const message = await engine.editMessage(requireString(body.channel, 'channel'), requireString(body.ts, 'ts'), body.text)
      sendJson(response, 200, { message })
    },
    'POST /local/message/delete': async (request, response) => {
      const body = await readJson(request)
      await engine.deleteMessage(requireString(body.channel, 'channel'), requireString(body.ts, 'ts'))
      sendJson(response, 200, { ok: true })
    },
    'POST /local/post': async (request, response) => {
      const body = await readJson(request)
      const threadTs = typeof body.threadTs === 'string' ? body.threadTs : undefined
      if (body.blocks !== undefined && (!Array.isArray(body.blocks) || body.blocks.some((block) => block?.type !== 'rich_text' || !Array.isArray(block.elements)))) throw new RequestError(400, 'invalid_blocks')
      const clientMsgId = typeof body.clientMsgId === 'string' ? body.clientMsgId : undefined
      let files: SlackFile[] | undefined
      if (body.files !== undefined) {
        if (!Array.isArray(body.files) || !body.files.length || body.files.some((file) => !/^F[A-Z0-9]+$/.test(file?.id))) throw new RequestError(400, 'invalid_files')
        files = body.files.map((file) => ({ id: file.id, title: typeof file.title === 'string' ? file.title : undefined }))
      }
      let gif: OutgoingMessage['gif']
      if (body.gif !== undefined) {
        const value = body.gif as Record<string, unknown>
        const url = requireString(value?.url, 'gif_url')
        if (!/^https:\/\/[^/]+\.klipy\.com\//i.test(url)) throw new RequestError(400, 'invalid_gif_url')
        gif = { url, title: requireString(value.title, 'gif_title') }
      }
      const ts = await engine.postMessage(requireString(body.channel, 'channel'), {
        text: typeof body.text === 'string' ? body.text : requireString(body.text, 'text'), blocks: body.blocks as RichTextBlock[] | undefined, gif, files,
        clientMsgId: clientMsgId ?? crypto.randomUUID(),
      }, threadTs)
      sendJson(response, 200, { ok: true, ts })
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
