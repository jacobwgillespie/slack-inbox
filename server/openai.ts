const RESPONSES_URL = 'https://api.openai.com/v1/responses'
const MAX_RETRIES = 4

export interface FunctionTool {
  type: 'function'
  name: string
  description: string
  strict: true
  parameters: Record<string, unknown>
}

export interface FunctionCall {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

export type OutputItem = FunctionCall | { type: string; [key: string]: unknown }

export type InputItem =
  | OutputItem
  | { role: 'user'; content: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export interface ResponseRequest {
  model: string
  instructions: string
  input: InputItem[]
  tools: FunctionTool[]
}

interface ResponseBody {
  output?: OutputItem[]
  error?: { message?: string; code?: string }
}

export class OpenAIError extends Error {}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export function isFunctionCall(item: OutputItem): item is FunctionCall {
  return item.type === 'function_call'
}

export class OpenAIClient {
  constructor(private readonly apiKey: string) {}

  async respond(request: ResponseRequest): Promise<OutputItem[]> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, store: false, include: ['reasoning.encrypted_content'] }),
      })
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const seconds = Number(response.headers.get('retry-after')) || 2 ** attempt
        await wait(seconds * 1000)
        continue
      }
      const body = (await response.json().catch(() => ({}))) as ResponseBody
      if (!response.ok || body.error) {
        throw new OpenAIError(body.error?.message ?? `OpenAI request failed with status ${response.status}`)
      }
      return body.output ?? []
    }
  }
}
