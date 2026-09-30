import { resolve } from 'node:path'
import type { Logger, Plugin, PreviewServer, ViteDevServer } from 'vite'
import { Database } from './database.ts'
import { localApi } from './routes.ts'
import { credentialMode, SlackClient, type SlackCredentials } from './slack-client.ts'
import { SyncEngine } from './sync.ts'

export interface SlackInboxOptions extends SlackCredentials {
  databasePath: string
  openaiApiKey?: string
  classifierModel: string
}

function credentialProblems({ userToken, sessionToken, sessionCookie }: SlackCredentials): string[] {
  const problems: string[] = []
  if (sessionCookie?.startsWith('xoxc-')) {
    problems.push(
      'SLACK_SESSION_COOKIE holds an xoxc- token. Put the token in SLACK_SESSION_TOKEN and the d cookie (xoxd-) in SLACK_SESSION_COOKIE.',
    )
  } else if (sessionCookie && !sessionCookie.startsWith('xoxd-')) {
    problems.push('SLACK_SESSION_COOKIE must be the value of the d cookie, which starts with xoxd-.')
  }
  if (sessionToken && !sessionToken.startsWith('xoxc-')) problems.push('SLACK_SESSION_TOKEN must start with xoxc-.')
  if (sessionToken && !sessionCookie) problems.push('SLACK_SESSION_TOKEN is set, but SLACK_SESSION_COOKIE is missing.')
  if (!sessionToken && !userToken) problems.push('Set SLACK_USER_TOKEN or SLACK_SESSION_TOKEN in .env.local.')
  return problems
}

const MODE_DESCRIPTIONS = {
  session: 'session token (fast scans with client.counts)',
  user: 'user token (each scan checks every conversation)',
  none: 'no token',
}

export function slackInbox(options: SlackInboxOptions): Plugin {
  const attach = (server: ViteDevServer | PreviewServer, logger: Logger) => {
    const mode = credentialMode(options)
    const databasePath = resolve(options.databasePath)
    logger.info(`  Slack API: using ${MODE_DESCRIPTIONS[mode]}`)
    logger.info(`  Slack API: storing data in ${databasePath}`)
    for (const problem of credentialProblems(options)) logger.warn(`  Slack API: ${problem}`)

    const classifier = options.openaiApiKey
      ? { apiKey: options.openaiApiKey, model: options.classifierModel, databasePath }
      : undefined
    logger.info(
      classifier
        ? `  Classifier: sorting new messages with ${classifier.model}`
        : '  Classifier: off. Set OPENAI_API_KEY in .env.local to turn it on.',
    )

    const database = new Database(databasePath)
    const engine = new SyncEngine(database, new SlackClient(options), mode, classifier)
    server.middlewares.use(localApi(engine))
    engine.start()
    server.httpServer?.once('close', () => {
      void engine.stop().then(() => database.close())
    })
  }

  return {
    name: 'slack-inbox',
    configureServer: (server) => attach(server, server.config.logger),
    configurePreviewServer: (server) => attach(server, server.config.logger),
  }
}
