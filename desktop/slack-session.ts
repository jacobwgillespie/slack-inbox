import { net, type WebContentsView } from 'electron'
import type { SlackCredentials } from '../server/slack-client.ts'
import type { SyncEngine } from '../server/sync.ts'
import type { RealtimeEvent } from '../src/slack/types.ts'

function slackUrl(source: string) {
  const url = new URL(source)
  return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
}

/** Observe Slack's own connection without opening a second realtime socket. */
export async function observeSlack(view: WebContentsView, credentials: SlackCredentials, engine: SyncEngine, canRecover: () => boolean) {
  const contents = view.webContents
  const debuggerClient = contents.debugger
  const sockets = new Set<string>()
  const connectedSockets = new Set<string>()
  let monitoring = false
  let enabling = false
  let stopped = false
  let disconnectedAt = Date.now()
  let connected = false
  const updateConnection = () => {
    const next = connectedSockets.size > 0
    if (next === connected) return
    connected = next
    disconnectedAt = Date.now()
    engine.setExternalRealtime(connected)
  }
  const enable = async () => {
    if (stopped || enabling) return
    enabling = true
    try {
      if (!debuggerClient.isAttached()) debuggerClient.attach('1.3')
      await debuggerClient.sendCommand('Network.enable', { maxPostDataSize: 65536 })
      monitoring = true
    } catch (error) {
      console.warn('Could not observe Slack connection', error)
    } finally { enabling = false }
  }
  const captureRequest = async (request: { url: string; postData?: string; hasPostData?: boolean; headers: Record<string, string> }, requestId: string) => {
    if (!slackUrl(request.url)) return
    if (!new URL(request.url).pathname.startsWith('/api/')) return
    if (!request.postData && request.hasPostData) {
      try {
        request.postData = (await debuggerClient.sendCommand('Network.getRequestPostData', { requestId })).postData
      } catch { return }
    }
    const body = new URLSearchParams(request.postData ?? '')
    let token = body.get('token') ?? new URL(request.url).searchParams.get('token')
    if (!token && request.postData?.startsWith('{')) {
      try { token = JSON.parse(request.postData).token } catch { /* Not a JSON request. */ }
    }
    token ??= /name="token"\r?\n\r?\n([^\r\n]+)/.exec(request.postData ?? '')?.[1] ?? null
    token ??= /Bearer (xoxc-[^\s]+)/i.exec(request.headers.Authorization ?? request.headers.authorization ?? '')?.[1] ?? null
    if (typeof token === 'string' && token.startsWith('xoxc-') && credentials.sessionToken !== token) {
      credentials.sessionToken = token
      credentials.origin = new URL(request.url).origin
      engine.reauthenticate()
    }
  }
  debuggerClient.on('message', (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') void captureRequest(params.request, params.requestId)
    if (method === 'Network.webSocketCreated') {
      const url = new URL(params.url)
      if (url.protocol === 'wss:' && url.hostname.endsWith('.slack.com')) sockets.add(params.requestId)
    }
    if (method === 'Network.webSocketHandshakeResponseReceived' && sockets.has(params.requestId) && params.response.status === 101) {
      connectedSockets.add(params.requestId)
      updateConnection()
    }
    if (method === 'Network.webSocketFrameReceived' && sockets.has(params.requestId)) {
      try {
        const event = JSON.parse(params.response.payloadData) as RealtimeEvent
        if (event.type === 'hello') {
          connectedSockets.add(params.requestId)
          updateConnection()
        } else if (event.type === 'goodbye') {
          connectedSockets.delete(params.requestId)
          disconnectedAt = Date.now()
          updateConnection()
        }
        else if (event.type) engine.observeRealtime(event)
      } catch { /* Ignore binary frames and keepalive payloads. */ }
    }
    if (method === 'Network.webSocketClosed' && sockets.delete(params.requestId)) {
      connectedSockets.delete(params.requestId)
      if (!connectedSockets.size) disconnectedAt = Date.now()
      updateConnection()
    }
  })
  debuggerClient.on('detach', () => {
    monitoring = false
    sockets.clear()
    connectedSockets.clear()
    disconnectedAt = Date.now()
    if (!stopped) updateConnection()
  })
  // Enable monitoring before navigation so startup requests and socket handshakes aren't missed.
  await enable()
  const recovery = setInterval(() => {
    if (stopped || contents.isDestroyed()) return
    if (!monitoring) void enable()
    if (!monitoring || connectedSockets.size || Date.now() - disconnectedAt < 30_000 || !net.isOnline() || !canRecover()) return
    if (!contents.getURL().startsWith('https://app.slack.com/client/')) return
    disconnectedAt = Date.now()
    contents.reload()
  }, 5000)
  const stop = () => { stopped = true; clearInterval(recovery) }
  contents.once('destroyed', stop)
  return stop
}
