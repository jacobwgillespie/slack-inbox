import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after']

interface SlackCredentials {
  origin: string
  userToken?: string
  sessionToken?: string
  sessionCookie?: string
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString()
}

function credentialProblems({ userToken, sessionToken, sessionCookie }: SlackCredentials): string[] {
  const problems: string[] = []
  if (sessionCookie?.startsWith('xoxc-')) {
    problems.push('SLACK_SESSION_COOKIE holds an xoxc- token. Put the token in SLACK_SESSION_TOKEN and the d cookie (xoxd-) in SLACK_SESSION_COOKIE.')
  } else if (sessionCookie && !sessionCookie.startsWith('xoxd-')) {
    problems.push('SLACK_SESSION_COOKIE must be the value of the d cookie, which starts with xoxd-.')
  }
  if (sessionToken && !sessionToken.startsWith('xoxc-')) problems.push('SLACK_SESSION_TOKEN must start with xoxc-.')
  if (sessionToken && !sessionCookie) problems.push('SLACK_SESSION_TOKEN is set, but SLACK_SESSION_COOKIE is missing.')
  if (!sessionToken && !userToken) problems.push('Set SLACK_USER_TOKEN or SLACK_SESSION_TOKEN in .env.local.')
  return problems
}

function describeCredentials({ sessionToken, userToken }: SlackCredentials): string {
  if (sessionToken) return 'session token (fast scans with client.counts)'
  if (userToken) return 'user token (each scan checks every conversation)'
  return 'no token'
}

function slackApi(credentials: SlackCredentials): Plugin {
  const reportCredentials = (logger: { info: (message: string) => void; warn: (message: string) => void }) => {
    logger.info(`  Slack API: using ${describeCredentials(credentials)}`)
    for (const problem of credentialProblems(credentials)) logger.warn(`  Slack API: ${problem}`)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.startsWith('/api/')) return next()
    try {
      const body = new URLSearchParams(await readBody(request))
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
      if (credentials.sessionToken) {
        body.set('token', credentials.sessionToken)
        if (credentials.sessionCookie) headers.cookie = `d=${credentials.sessionCookie}`
      } else if (credentials.userToken) {
        headers.authorization = `Bearer ${credentials.userToken}`
      }

      const upstream = await fetch(`${credentials.origin}${request.url}`, { method: 'POST', headers, body })
      response.statusCode = upstream.status
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name)
        if (value) response.setHeader(name, value)
      }
      response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      response.statusCode = 502
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: false, error: 'proxy_error', detail: String(error) }))
    }
  }

  return {
    name: 'slack-api',
    configureServer: (server) => {
      reportCredentials(server.config.logger)
      server.middlewares.use(handle)
    },
    configurePreviewServer: (server) => {
      reportCredentials(server.config.logger)
      server.middlewares.use(handle)
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      slackApi({
        origin: env.SLACK_API_ORIGIN || 'https://slack.com',
        userToken: env.SLACK_USER_TOKEN,
        sessionToken: env.SLACK_SESSION_TOKEN,
        sessionCookie: env.SLACK_SESSION_COOKIE,
      }),
    ],
  }
})
