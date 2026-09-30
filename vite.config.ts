import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

function slackProxy(token: string | undefined, target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (request) => {
        request.removeHeader('origin')
        request.removeHeader('referer')
        request.removeHeader('cookie')
        if (token) request.setHeader('authorization', `Bearer ${token}`)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxy = { '/api': slackProxy(env.SLACK_USER_TOKEN, env.SLACK_API_ORIGIN || 'https://slack.com') }
  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  }
})
