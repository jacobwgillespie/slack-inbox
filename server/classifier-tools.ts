import { DatabaseSync } from 'node:sqlite'
import type { ClassificationLabel, SavedItemReference } from '../src/slack/types.ts'
import type { Database } from './database.ts'
import type { FunctionCall, FunctionTool } from './openai.ts'

const MAX_QUERY_ROWS = 50
const MAX_QUERY_OUTPUT = 20000
const READ_QUERY = /^\s*(select|with)\b/i

const DATABASE_DESCRIPTION = `The database is SQLite. Timestamps named ts are Slack message timestamps such as "1790783004.000100" (seconds since 1970). They sort correctly as text.

Tables:
- conversations(id, data, is_member, is_muted, last_read, history_latest). data is JSON: {"id", "name", "kind": "channel" | "private" | "dm" | "group", "userId" for direct messages}.
- messages(conversation_id, ts, thread_ts, user_id, subtype, data). data is JSON with "text", "user", "thread_ts", "reply_count", "reactions", "files", "attachments", "bot_profile". A thread reply has thread_ts different from ts. The database holds recent unread messages, followed threads, and messages the user opened, not full history.
- users(id, data). data is JSON: {"id", "handle", "displayName"}.
- threads(conversation_id, thread_ts, last_read): threads the user follows.
- classifications(conversation_id, ts, label, reason, source, previous_label, created_at). source is "model" or "user". A "user" row is a correction by the user.
- memories(id, content, created_at, updated_at).
- saved_items(conversation_id, ts, state, date_created): messages the user saved for later.

Use json_extract(data, '$.text') to read JSON fields.`

const labelProperty = { type: 'string', enum: ['important', 'other'] }

export const CLASSIFIER_TOOLS: FunctionTool[] = [
  {
    type: 'function',
    name: 'classify_message',
    description: 'Record the classification of one message from the current batch. Call this once for every message.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The id of the message from the batch.' },
        label: labelProperty,
        reason: { type: 'string', description: 'One short sentence that explains the decision to the user.' },
      },
      required: ['message_id', 'label', 'reason'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'save_memory',
    description:
      'Save a short, general rule or fact that will help classify future messages, such as a preference the user showed through a correction.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'update_memory',
    description: 'Replace the content of an existing memory.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { memory_id: { type: 'integer' }, content: { type: 'string' } },
      required: ['memory_id', 'content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delete_memory',
    description: 'Delete a memory that is wrong, outdated, or duplicated.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { memory_id: { type: 'integer' } },
      required: ['memory_id'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'query_database',
    description: `Run one read-only SQL SELECT statement against the local Slack database and return up to ${MAX_QUERY_ROWS} rows as JSON. Use it when a message needs more context, for example earlier messages in the conversation, the thread it belongs to, how the user classified similar messages, or who the author is.\n\n${DATABASE_DESCRIPTION}`,
    strict: true,
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
      additionalProperties: false,
    },
  },
]

export interface ToolContext {
  batch: Map<string, SavedItemReference>
  classified: Set<string>
  model: string
}

type ToolArguments = Record<string, unknown>

export class ClassifierToolbox {
  private readonly readOnly: DatabaseSync

  constructor(
    private readonly database: Database,
    databasePath: string,
  ) {
    this.readOnly = new DatabaseSync(databasePath, { readOnly: true })
  }

  close() {
    this.readOnly.close()
  }

  execute(call: FunctionCall, context: ToolContext): string {
    let args: ToolArguments
    try {
      args = JSON.parse(call.arguments) as ToolArguments
    } catch {
      return 'Error: the arguments were not valid JSON.'
    }
    try {
      switch (call.name) {
        case 'classify_message':
          return this.classify(args, context)
        case 'save_memory':
          return `Saved memory ${this.database.addMemory(String(args.content))}.`
        case 'update_memory':
          return this.database.updateMemory(Number(args.memory_id), String(args.content))
            ? 'Memory updated.'
            : 'Error: no memory has that id.'
        case 'delete_memory':
          return this.database.deleteMemory(Number(args.memory_id)) ? 'Memory deleted.' : 'Error: no memory has that id.'
        case 'query_database':
          return this.query(String(args.sql))
        default:
          return `Error: unknown tool ${call.name}.`
      }
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private classify(args: ToolArguments, context: ToolContext): string {
    const id = String(args.message_id)
    const reference = context.batch.get(id)
    if (!reference) return `Error: ${id} is not in the current batch.`
    const label = args.label as ClassificationLabel
    this.database.saveModelClassification(reference, label, String(args.reason), context.model)
    context.classified.add(id)
    return 'Recorded.'
  }

  private query(sql: string): string {
    const statement = sql.trim().replace(/;\s*$/, '')
    if (!READ_QUERY.test(statement) || statement.includes(';')) {
      return 'Error: only one SELECT statement is allowed.'
    }
    const rows: unknown[] = []
    for (const row of this.readOnly.prepare(statement).iterate()) {
      rows.push(row)
      if (rows.length >= MAX_QUERY_ROWS) break
    }
    const output = JSON.stringify(rows)
    return output.length > MAX_QUERY_OUTPUT ? `${output.slice(0, MAX_QUERY_OUTPUT)}… (output truncated)` : output
  }
}
