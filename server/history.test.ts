import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { Message } from '../src/slack/types.ts'
import { compareTs } from '../src/slack/timestamps.ts'
import { Database } from './database.ts'
import { History } from './history.ts'
import type { Params, SlackClient } from './slack-client.ts'

const BASE = 1700000000
const channel = 'D1'
const ts = (index: number) => `${BASE + index}.000001`
const message = (index: number): Message => ({ ts: ts(index), text: `Message ${index}`, user: index % 2 ? 'me' : 'them' })

function fixture(t: TestContext, count: number) {
  const directory = mkdtempSync(join(tmpdir(), 'slack-history-'))
  const path = join(directory, 'slack.sqlite')
  let database = new Database(path)
  let now = (BASE + count + 1) * 1000
  t.mock.method(Date, 'now', () => now)
  database.replaceConversations([{ id: channel, name: 'them', kind: 'dm', userId: 'them' }])
  database.setReadStates([[channel, ts(count)]])
  const data = {
    messages: Array.from({ length: count }, (_, index) => message(index + 1)),
    calls: [] as Params[],
  }
  const client: Pick<SlackClient, 'call'> = {
    async call<T>(method: string, params: Params = {}): Promise<T> {
      assert.equal(method, 'conversations.history')
      data.calls.push(params)
      await Promise.resolve()
      const matching = data.messages.filter((entry) => compareTs(entry.ts, String(params.latest)) < 0)
        .sort((a, b) => compareTs(b.ts, a.ts))
      return { messages: matching.slice(0, Number(params.limit)), has_more: matching.length > Number(params.limit) } as T
    },
  }
  let history = new History(database, client)
  t.after(() => { database.close(); rmSync(directory, { recursive: true }) })
  return {
    data,
    get database() { return database },
    get history() { return history },
    advance(seconds: number) { now += seconds * 1000 },
    restart() {
      database.close()
      database = new Database(path)
      history = new History(database, client)
    },
  }
}

const options = { maxAge: 300000 }

test('read and muted DMs remain visible; complete history includes both authors and survives restart', async (t) => {
  const f = fixture(t, 20)
  f.database.setMuted(channel, true)
  assert.equal(f.database.inbox('me', 100).length, 0)
  assert.equal(f.database.directMessages().length, 1)
  const first = await f.history.page(channel, options)
  assert.equal(first.messages.length, 20)
  assert.deepEqual(new Set(first.messages.map((entry) => entry.user)), new Set(['me', 'them']))
  assert.equal(first.hasMore, false)
  f.restart()
  assert.deepEqual(await f.history.page(channel, options), first)
  assert.equal(f.data.calls.length, 1)
  assert.equal((await f.history.page(channel, { ...options, cached: true, after: ts(1) })).hasMore, false)
})

test('older pages are lazy, share concurrent fetches, and are reused without skips or duplicates', async (t) => {
  const f = fixture(t, 350)
  const first = await f.history.page(channel, options)
  assert.equal(f.data.calls.length, 1)
  assert.equal(first.before, ts(251))
  const [second, duplicate] = await Promise.all([
    f.history.page(channel, { ...options, before: first.before }),
    f.history.page(channel, { ...options, before: first.before }),
  ])
  assert.deepEqual(second, duplicate)
  assert.equal(f.data.calls.length, 2)
  assert.deepEqual(await f.history.page(channel, { ...options, before: first.before }), second)
  assert.equal(f.data.calls.length, 2)
  const third = await f.history.page(channel, { ...options, before: second.before })
  const last = await f.history.page(channel, { ...options, before: third.before })
  assert.equal(last.hasMore, false)
  assert.deepEqual([...last.messages, ...third.messages, ...second.messages, ...first.messages].map((entry) => entry.ts),
    f.data.messages.map((entry) => entry.ts))
})

test('isolated saved and unread messages do not falsely establish complete history', async (t) => {
  const f = fixture(t, 250)
  f.database.upsertMessages(channel, [message(1), message(249)])
  const first = await f.history.page(channel, options)
  assert.equal(first.before, ts(151))
  const second = await f.history.page(channel, { ...options, before: first.before })
  assert.equal(second.before, ts(51))
  assert.equal(second.messages.length, 100)
  assert.equal(f.data.calls.length, 2)
})

test('refreshes apply edits and deletions while preserving earlier cached pages', async (t) => {
  const f = fixture(t, 250)
  const first = await f.history.page(channel, options)
  await f.history.page(channel, { ...options, before: first.before })
  f.data.messages = f.data.messages.filter((entry) => entry.ts !== ts(200))
  f.data.messages.find((entry) => entry.ts === ts(201))!.text = 'Edited'
  f.advance(301)
  await f.history.page(channel, options)
  const refreshed = await f.history.page(channel, { ...options, cached: true, after: ts(51) })
  assert.equal(refreshed.messages.length, 199)
  assert.equal(refreshed.messages.find((entry) => entry.ts === ts(200)), undefined)
  assert.equal(refreshed.messages.find((entry) => entry.ts === ts(201))?.text, 'Edited')
  assert.equal(refreshed.messages[0]?.ts, ts(51))
})

test('a new head separated from cached history leaves a fetchable gap', async (t) => {
  const f = fixture(t, 350)
  const first = await f.history.page(channel, options)
  f.data.messages.push(...Array.from({ length: 350 }, (_, index) => message(index + 351)))
  f.advance(351)
  await f.history.page(channel, options)
  const refreshed = await f.history.page(channel, { ...options, cached: true, after: first.before })
  assert.equal(refreshed.before, ts(601))
  assert.equal(refreshed.messages.length, 100)
  const older = await f.history.page(channel, { ...options, before: refreshed.before })
  assert.equal(older.before, ts(501))
  assert.equal(older.messages.length, 100)
  assert.equal(f.data.calls.length, 3)
})

test('live messages reuse SQLite; reconnection revalidates coverage before trusting new messages', async (t) => {
  const f = fixture(t, 20)
  await f.history.page(channel, { ...options, live: true })
  f.database.upsertMessages(channel, [message(21)])
  f.history.observeMessage(channel, ts(21))
  const live = await f.history.page(channel, { ...options, cached: true, after: ts(1) })
  assert.equal(live.messages.at(-1)?.ts, ts(21))
  assert.equal(f.data.calls.length, 1)
  f.history.invalidateLive()
  f.data.messages.push(...Array.from({ length: 180 }, (_, index) => message(index + 21)))
  f.database.upsertMessages(channel, [message(200)])
  f.history.observeMessage(channel, ts(200))
  assert.equal((await f.history.page(channel, { ...options, cached: true })).messages.at(-1)?.ts, ts(21))
  f.advance(181)
  const reconnected = await f.history.page(channel, { ...options, live: true })
  assert.equal(reconnected.messages.at(-1)?.ts, ts(200))
  assert.equal(reconnected.before, ts(101))
  assert.equal(f.data.calls.length, 2)
})
