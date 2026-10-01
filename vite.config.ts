import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig, loadEnv } from 'vite'
import { slackInbox } from './server/plugin.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset({ target: '19' })] }),
      slackInbox({
        origin: env.SLACK_API_ORIGIN || 'https://slack.com',
        userToken: env.SLACK_USER_TOKEN,
        sessionToken: env.SLACK_SESSION_TOKEN,
        sessionCookie: env.SLACK_SESSION_COOKIE,
        databasePath: env.SLACK_DATABASE_PATH || 'data/slack.sqlite',
        openaiApiKey: env.OPENAI_API_KEY,
        classifierModel: env.OPENAI_CLASSIFIER_MODEL || 'gpt-6-luna',
      }),
    ],
    server: { watch: { ignored: ['**/data/**'] } },
  }
})
