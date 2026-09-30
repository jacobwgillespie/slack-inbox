import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { slackInbox } from './server/plugin'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      slackInbox({
        origin: env.SLACK_API_ORIGIN || 'https://slack.com',
        userToken: env.SLACK_USER_TOKEN,
        sessionToken: env.SLACK_SESSION_TOKEN,
        sessionCookie: env.SLACK_SESSION_COOKIE,
        databasePath: env.SLACK_DATABASE_PATH || 'data/slack.sqlite',
      }),
    ],
    server: { watch: { ignored: ['**/data/**'] } },
  }
})
