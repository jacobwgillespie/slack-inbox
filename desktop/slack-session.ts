import type { WebContentsView } from 'electron'
import type { SlackCredentials } from '../server/slack-client.ts'
import type { SyncEngine } from '../server/sync.ts'
import type { RealtimeEvent } from '../src/slack/types.ts'

function slackUrl(source: string) {
  const url = new URL(source)
  return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))
}

/** Observe Slack's own connection without opening a second realtime socket. */
export function observeSlack(view: WebContentsView, credentials: SlackCredentials, engine: SyncEngine) {
  const debuggerClient = view.webContents.debugger
  const sockets = new Set<string>()
  debuggerClient.attach('1.3')
  void debuggerClient.sendCommand('Network.enable', { maxPostDataSize: 65536 })
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
    if (method === 'Network.webSocketFrameReceived' && sockets.has(params.requestId)) {
      try {
        const event = JSON.parse(params.response.payloadData) as RealtimeEvent
        if (event.type === 'hello') engine.setExternalRealtime(true)
        else if (event.type === 'goodbye') engine.setExternalRealtime(false)
        else if (event.type) engine.observeRealtime(event)
      } catch { /* Ignore binary frames and keepalive payloads. */ }
    }
    if (method === 'Network.webSocketClosed' && sockets.delete(params.requestId)) {
      if (!sockets.size) engine.setExternalRealtime(false)
    }
  })
  debuggerClient.on('detach', () => engine.setExternalRealtime(false))
}
