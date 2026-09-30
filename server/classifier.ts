import type { ClassifierStatus, InboxItem, Message, SavedItemReference, Session, User } from '../src/slack/types.ts'
import { ClassifierToolbox, CLASSIFIER_TOOLS, type ToolContext } from './classifier-tools.ts'
import type { Correction, Database } from './database.ts'
import { isFunctionCall, OpenAIClient, type InputItem } from './openai.ts'

const BATCH_SIZE = 25
const MAX_BATCHES_PER_RUN = 8
const MAX_TURNS = 12
const MAX_ATTEMPTS = 3
const MAX_MESSAGE_AGE = 7 * 24 * 60 * 60
const MAX_TEXT_LENGTH = 1500
const CORRECTION_LIMIT = 20
const SCHEDULE_DELAY = 3000
const RETRY_DELAY = 60 * 1000

const INSTRUCTIONS = `You sort Slack messages for one person into two groups:

- "important": messages this person should read soon. Examples: a direct question or request to them, a mention of them, a decision or change that affects their work, a problem in something they own, and messages from people who work closely with them.
- "other": messages they can read later or skip. Examples: general announcements, automated notifications that need no action from them, social conversation, and discussion that does not involve them.

For each message in the batch, call classify_message exactly once. Give a short reason the person can understand at a glance.

The memories list holds rules you saved earlier. Follow them. They take priority over the general guidance above.

The corrections list shows messages where the person changed your classification. Look for the pattern behind each correction. Save a memory when you learn a general rule, for example "Messages from the deploy bot in #releases are other unless a deploy failed." Keep memories short and general. Update or delete a memory instead of saving a duplicate or a contradicting one. Do not save a memory for a single message.

You can use query_database for more context, for example earlier messages in the same conversation or how the person classified similar messages. Use it only when the batch does not give you enough information. When every message is classified and your memories are up to date, reply with a short summary and stop.`

interface PendingMessage {
  id: string
  item: InboxItem
  message: Message
}

export interface ClassifierContext {
  session: () => Session | undefined
  unreadItems: () => InboxItem[]
  onStatus: (status: ClassifierStatus) => void
  changed: () => void
}

export interface ClassifierOptions {
  apiKey: string
  model: string
  databasePath: string
}

function messageId(channel: string, ts: string) {
  return `${channel}:${ts}`
}

function readableText(text: string, users: Record<string, User>): string {
  const readable = text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${users[id]?.displayName ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  return readable.length > MAX_TEXT_LENGTH ? `${readable.slice(0, MAX_TEXT_LENGTH)}…` : readable
}

function messageContent(message: Message): string {
  const parts = [message.text]
  for (const attachment of message.attachments ?? []) {
    parts.push([attachment.pretext, attachment.title, attachment.text ?? attachment.fallback].filter(Boolean).join(' '))
  }
  for (const file of message.files ?? []) parts.push(`[file: ${file.title ?? file.name ?? 'file'}]`)
  return parts.filter(Boolean).join('\n')
}

function conversationDescription(item: InboxItem, users: Record<string, User>): string {
  const { conversation } = item
  switch (conversation.kind) {
    case 'dm':
      return `direct message with ${users[conversation.userId ?? '']?.displayName ?? conversation.name}`
    case 'group':
      return `group message with ${conversation.name}`
    case 'private':
      return `private channel #${conversation.name}`
    case 'channel':
      return `channel #${conversation.name}`
  }
}

export class Classifier {
  private readonly openai: OpenAIClient
  private readonly toolbox: ClassifierToolbox
  private status: ClassifierStatus = { enabled: true, running: false, pending: 0 }
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private rerun = false
  private retryAt = 0
  private stopped = false

  constructor(
    private readonly database: Database,
    private readonly options: ClassifierOptions,
    private readonly context: ClassifierContext,
  ) {
    this.openai = new OpenAIClient(options.apiKey)
    this.toolbox = new ClassifierToolbox(database, options.databasePath)
  }

  currentStatus(): ClassifierStatus {
    return this.status
  }

  schedule(delay = SCHEDULE_DELAY) {
    if (this.stopped) return
    if (this.running) {
      this.rerun = true
      return
    }
    clearTimeout(this.timer)
    const wait = Math.max(delay, this.retryAt - Date.now())
    this.timer = setTimeout(() => {
      this.running = this.run().finally(() => {
        this.running = undefined
        if (this.rerun) {
          this.rerun = false
          this.schedule()
        }
      })
    }, wait)
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    await this.running?.catch(() => undefined)
    this.toolbox.close()
  }

  private setStatus(patch: Partial<ClassifierStatus>) {
    this.status = { ...this.status, ...patch }
    this.context.onStatus(this.status)
  }

  private pendingMessages(): PendingMessage[] {
    const items = this.context.unreadItems()
    const classifications = this.database.classifications(items.map((item) => item.conversation.id))
    const attempts = this.database.classificationAttempts()
    const oldest = Date.now() / 1000 - MAX_MESSAGE_AGE
    const pending: PendingMessage[] = []
    for (const item of items) {
      for (const message of item.messages) {
        const id = messageId(item.conversation.id, message.ts)
        if (classifications.has(id) || (attempts.get(id) ?? 0) >= MAX_ATTEMPTS) continue
        if (Number(message.ts) < oldest) continue
        pending.push({ id, item, message })
      }
    }
    return pending.sort((a, b) => b.message.ts.localeCompare(a.message.ts))
  }

  private async run() {
    const session = this.context.session()
    if (!session || this.stopped) return
    this.retryAt = 0
    this.setStatus({ running: true, error: undefined, pending: this.pendingMessages().length })
    try {
      for (let batchNumber = 0; batchNumber < MAX_BATCHES_PER_RUN && !this.stopped; batchNumber++) {
        const batch = this.pendingMessages().slice(0, BATCH_SIZE)
        const corrections = this.database.unreviewedCorrections(CORRECTION_LIMIT)
        if (!batch.length && !corrections.length) break
        await this.classifyBatch(session, batch, corrections)
        this.setStatus({ pending: this.pendingMessages().length })
        this.context.changed()
      }
    } catch (error) {
      console.warn('Message classification failed', error)
      this.setStatus({ error: error instanceof Error ? error.message : String(error) })
      this.retryAt = Date.now() + RETRY_DELAY
    } finally {
      const pending = this.pendingMessages().length
      this.setStatus({ running: false, pending })
      if (pending) this.rerun = true
    }
  }

  private async classifyBatch(session: Session, batch: PendingMessage[], corrections: Correction[]) {
    const userIds = new Set([session.userId])
    for (const { item, message } of batch) {
      if (message.user) userIds.add(message.user)
      if (item.conversation.userId) userIds.add(item.conversation.userId)
      for (const match of message.text.matchAll(/<@([A-Z0-9]+)/g)) if (match[1]) userIds.add(match[1])
    }
    const users = this.database.usersById([...userIds])

    const request = {
      person: { name: users[session.userId]?.displayName ?? session.handle, handle: session.handle, id: session.userId },
      memories: this.database.memories().map(({ id, content }) => ({ id, content })),
      corrections: corrections.map((correction) => ({
        conversation_id: correction.channel,
        ts: correction.ts,
        text: readableText(correction.text, users),
        changed_from: correction.previousLabel ?? 'unclassified',
        changed_to: correction.label,
      })),
      messages: batch.map(({ id, item, message }) => ({
        id,
        conversation: conversationDescription(item, users),
        author: users[message.user ?? '']?.displayName ?? message.bot_profile?.name ?? message.username ?? 'unknown',
        author_is_bot: !message.user || Boolean(message.bot_profile),
        sent_at: new Date(Number(message.ts) * 1000).toISOString(),
        mentions_person: message.text.includes(`<@${session.userId}`),
        mentions_everyone: /<!(here|channel|everyone)>/.test(message.text),
        reply_count: message.reply_count ?? 0,
        text: readableText(messageContent(message), users),
      })),
    }

    const toolContext: ToolContext = {
      batch: new Map(batch.map(({ id, item, message }) => [id, { channel: item.conversation.id, ts: message.ts }])),
      classified: new Set(),
      model: this.options.model,
    }
    const input: InputItem[] = [{ role: 'user', content: JSON.stringify(request, null, 1) }]

    try {
      for (let turn = 0; turn < MAX_TURNS && !this.stopped; turn++) {
        const output = await this.openai.respond({
          model: this.options.model,
          instructions: INSTRUCTIONS,
          input,
          tools: CLASSIFIER_TOOLS,
        })
        input.push(...output)
        const calls = output.filter(isFunctionCall)
        if (!calls.length) break
        for (const call of calls) {
          input.push({ type: 'function_call_output', call_id: call.call_id, output: this.toolbox.execute(call, toolContext) })
        }
        if (toolContext.classified.size) this.context.changed()
      }
    } finally {
      const unclassified: SavedItemReference[] = batch
        .filter(({ id }) => !toolContext.classified.has(id))
        .map(({ item, message }) => ({ channel: item.conversation.id, ts: message.ts }))
      this.database.recordClassificationAttempts(unclassified)
    }
    this.database.markCorrectionsReviewed(corrections)
  }
}
