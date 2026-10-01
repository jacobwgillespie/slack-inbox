import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Database } from './database.ts'
import { Files } from './files.ts'
import { SlackClient, SlackError } from './slack-client.ts'

test('legacy file metadata is resolved once and image bytes are shared and persisted', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'slack-images-'))
  const path = join(directory, 'slack.sqlite')
  let database = new Database(path)
  t.after(() => { database.close(); rmSync(directory, { recursive: true }) })
  database.upsertMessages('D1', [{ ts: '1.000001', text: '', files: [{ id: 'F1', name: 'image.png' }] }])
  let infoCalls = 0
  let downloads = 0
  const client: Pick<SlackClient, 'call' | 'downloadFile'> = {
    async call<T>() {
      infoCalls++
      return { file: { id: 'F1', mimetype: 'image/png', thumb_720: 'https://files.slack.com/preview.png' } } as T
    },
    async downloadFile() {
      downloads++
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    },
  }
  const files = new Files(database, client)
  const [first, second] = await Promise.all([files.image('F1'), files.image('F1')])
  assert.deepEqual(first, second)
  assert.equal(infoCalls, 1)
  assert.equal(downloads, 1)
  database.close()
  database = new Database(path)
  assert.deepEqual(await new Files(database, client).image('F1'), first)
  assert.equal(downloads, 1)
  await assert.rejects(new Files(database, client).image('unknown'), (error: unknown) => error instanceof SlackError && error.code === 'file_not_found')
  assert.equal(infoCalls, 1)
})

test('file redirects cannot leak credentials outside Slack or to its CDN', async (t) => {
  const calls: { url: string; headers: Record<string, string> }[] = []
  let destination = 'https://example.com/image.png'
  t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    calls.push({ url: String(url), headers: options.headers as Record<string, string> })
    if (url.hostname === 'files.slack.com') return new Response(null, { status: 302, headers: { location: destination } })
    return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
  })
  const client = new SlackClient({ origin: 'https://slack.com', sessionToken: 'test-token', sessionCookie: 'test-cookie' })
  await assert.rejects(client.downloadFile('https://files.slack.com/image.png'),
    (error: unknown) => error instanceof SlackError && error.code === 'invalid_file_host')
  assert.equal(calls.length, 1)
  destination = 'https://a.slack-edge.com/image.png'
  await client.downloadFile('https://files.slack.com/image.png')
  assert.equal(calls[1]!.headers.authorization, 'Bearer test-token')
  assert.equal(calls[1]!.headers.cookie, 'd=test-cookie')
  assert.deepEqual(calls[2]!.headers, {})
})
