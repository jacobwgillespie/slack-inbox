import type { RealtimeState } from '../src/slack/types'
import { SlackError, type SlackClient } from './slack-client'

const PING_INTERVAL = 30 * 1000
const STALE_CONNECTION_AGE = 2 * PING_INTERVAL
const INITIAL_RECONNECT_DELAY = 1000
const MAX_RECONNECT_DELAY = 60 * 1000
const UNSUPPORTED_TOKEN_ERRORS = new Set(['not_allowed_token_type', 'method_deprecated', 'missing_scope'])

export interface RealtimeEvent {
  type: string
  [key: string]: unknown
}

export interface RealtimeHandlers {
  onEvent: (event: RealtimeEvent) => void
  onStateChange: (state: RealtimeState) => void
  onConnected: () => void
}

type WebSocketWithHeaders = new (url: string, options?: { headers?: Record<string, string> }) => WebSocket
const NodeWebSocket = WebSocket as unknown as WebSocketWithHeaders

export class RealtimeConnection {
  private socket?: WebSocket
  private stopped = false
  private reconnectDelay = INITIAL_RECONNECT_DELAY
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private pingTimer?: ReturnType<typeof setInterval>
  private lastMessageAt = 0
  private pingId = 0

  constructor(
    private readonly client: SlackClient,
    private readonly handlers: RealtimeHandlers,
  ) {}

  start() {
    void this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    clearInterval(this.pingTimer)
    this.socket?.close()
  }

  private async connect() {
    if (this.stopped) return
    this.handlers.onStateChange('connecting')

    let url: string
    try {
      url = (await this.client.call<{ url: string }>('rtm.connect')).url
    } catch (error) {
      if (error instanceof SlackError && UNSUPPORTED_TOKEN_ERRORS.has(error.code)) {
        this.handlers.onStateChange('unavailable')
        return
      }
      console.warn('Could not start the Slack real-time connection', error)
      this.scheduleReconnect()
      return
    }
    if (this.stopped) return

    const socket = new NodeWebSocket(url, { headers: this.client.realtimeHeaders() })
    this.socket = socket
    this.lastMessageAt = Date.now()

    socket.onmessage = (message) => {
      this.lastMessageAt = Date.now()
      let event: RealtimeEvent
      try {
        event = JSON.parse(String(message.data)) as RealtimeEvent
      } catch {
        return
      }
      if (event.type === 'hello') {
        this.reconnectDelay = INITIAL_RECONNECT_DELAY
        this.handlers.onStateChange('connected')
        this.handlers.onConnected()
      } else if (event.type === 'goodbye') {
        socket.close()
      } else if (event.type !== 'pong') {
        this.handlers.onEvent(event)
      }
    }
    socket.onerror = () => undefined
    socket.onclose = () => {
      clearInterval(this.pingTimer)
      if (this.socket !== socket || this.stopped) return
      this.handlers.onStateChange('disconnected')
      this.scheduleReconnect()
    }

    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > STALE_CONNECTION_AGE) {
        socket.close()
        return
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++this.pingId, type: 'ping' }))
    }, PING_INTERVAL)
  }

  private scheduleReconnect() {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => void this.connect(), this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY)
  }
}
