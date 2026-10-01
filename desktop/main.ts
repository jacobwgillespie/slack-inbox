import { app, BaseWindow, WebContentsView, ipcMain, session, shell } from 'electron'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { Database } from '../server/database.ts'
import { SlackClient, SlackError, type SlackCredentials } from '../server/slack-client.ts'
import { SyncEngine } from '../server/sync.ts'
import { localApi } from '../server/routes.ts'
import { configuredSession } from './configured-session.ts'
import { BrowserSignin } from './browser-signin.ts'
import { readConversation, scrollConversation } from './conversation.ts'
import { observeSlack } from './slack-session.ts'

app.setName('Slack Inbox')
if (!app.requestSingleInstanceLock()) app.quit()
else void start().catch((error) => { console.error('Could not start Slack Inbox', error); app.quit() })

async function start() {
  await app.whenReady()
  const root = resolve(__dirname, '..')
  const slackSession = session.fromPartition('persist:slack')
  slackSession.setUserAgent(app.userAgentFallback.replace(/\s(?:Electron|slack-inbox|SlackInbox)\/[^ ]+/gi, ''))
  slackSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
  slackSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
  const browserSignin = new BrowserSignin(join(app.getPath('userData'), 'signin-chrome'), slackSession)
  const credentials: SlackCredentials = { origin: 'https://slack.com' }
  const configuredTeam = await configuredSession(root, slackSession, credentials)
  const database = new Database(process.env.SLACK_DESKTOP_DATABASE_PATH || join(app.getPath('userData'), 'slack.sqlite'))
  const transport: typeof fetch = (input, init) => {
    if (!credentials.sessionToken) return Promise.reject(new SlackError('auth.test', 'not_authed'))
    return slackSession.fetch(input instanceof Request ? input : String(input), { ...init, credentials: 'include' })
  }
  const engine = new SyncEngine(database, new SlackClient(credentials, transport), 'session', undefined, true)
  const api = localApi(engine)
  const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
  const server = createServer((request, response) => {
    // Only our own renderer can invoke the loopback API, including its write routes.
    const requestOrigin = request.headers.origin
    if (request.headers.host !== new URL(origin).host || request.headers['sec-fetch-site'] === 'cross-site' ||
        (requestOrigin && requestOrigin !== `http://${request.headers.host}`)) {
      response.writeHead(403).end()
      return
    }
    void api(request, response, () => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      const file = resolve(root, 'dist', pathname === '/' ? 'index.html' : `.${pathname}`)
      if (!file.startsWith(join(root, 'dist') + '/')) { response.writeHead(403).end(); return }
      void readFile(file).then((bytes) => {
        response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' }).end(bytes)
      }).catch(() => response.writeHead(404).end())
    })
  })
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(Number(process.env.SLACK_DESKTOP_PORT || 5174), '127.0.0.1', done) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local server address')
  const origin = `http://127.0.0.1:${address.port}`
  const window = new BaseWindow({
    title: 'Slack Inbox',
    width: 1440, height: 1000, backgroundColor: '#080808',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 20, y: 35 } } : {}),
  })
  const ui = new WebContentsView({ webPreferences: {
    preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
  } })
  const slack = new WebContentsView({ webPreferences: {
    session: slackSession, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
  } })
  slack.webContents.setUserAgent(slackSession.getUserAgent())
  window.contentView.addChildView(slack)
  window.contentView.addChildView(ui)
  slack.setVisible(true)
  observeSlack(slack, credentials, engine)
  const layout = () => {
    const { width, height } = window.getContentBounds()
    const toolbarHeight = process.platform === 'darwin' ? 68 : 44
    ui.setBounds({ x: 0, y: 0, width, height: slackVisible ? toolbarHeight : height })
    slack.setBounds({ x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) })
  }
  let slackVisible = false
  const showSlack = async (channel?: string) => {
    const team = database.getMetadata<{ teamId: string }>('session')?.teamId
    slackVisible = true
    window.contentView.addChildView(ui)
    slack.setVisible(true)
    layout()
    slack.webContents.focus()
    if (channel && team) {
      const destination = `https://app.slack.com/client/${team}/${channel}`
      if (slack.webContents.getURL() !== destination) await slack.webContents.loadURL(destination)
    }
  }

  const ownRenderer = (event: Electron.IpcMainInvokeEvent) => event.sender === ui.webContents && event.senderFrame?.url.startsWith(origin + '/')
  ipcMain.handle('slack:show', (event, channel: unknown) => {
    if (!ownRenderer(event)) throw new Error('Invalid IPC sender')
    if (channel !== undefined && (typeof channel !== 'string' || !/^[CDG][A-Z0-9]+$/.test(channel))) throw new Error('Invalid conversation')
    return showSlack(channel as string | undefined)
  })
  let selectedChannel: string | undefined
  const imageSources = new Set<string>()
  const imageCache = new Map<string, string>()
  const validChannel = (channel: unknown): channel is string => typeof channel === 'string' && /^[DG][A-Z0-9]+$/.test(channel)
  ipcMain.handle('slack:conversation-open', async (event, channel: unknown) => {
    if (!ownRenderer(event) || !validChannel(channel)) throw new Error('Invalid conversation')
    const team = database.getMetadata<{ teamId: string }>('session')?.teamId
    if (!team) throw new Error('Slack is not signed in.')
    selectedChannel = channel
    const destination = `https://app.slack.com/client/${team}/${channel}`
    if (slack.webContents.getURL() !== destination) {
      try { await slack.webContents.loadURL(destination) }
      catch (error) { if (selectedChannel === channel) throw error }
    }
  })
  ipcMain.handle('slack:conversation-read', async (event, channel: unknown, direction: unknown) => {
    if (!ownRenderer(event) || !validChannel(channel) || selectedChannel !== channel) throw new Error('Conversation is no longer active.')
    if (direction !== undefined && direction !== 'older' && direction !== 'latest') throw new Error('Invalid scroll direction')
    if (slack.webContents.getURL().split('/')[5] !== channel) return { channel, messages: [], ready: false, hasMore: false }
    if (direction) await scrollConversation(slack.webContents, direction)
    const snapshot = await readConversation(slack.webContents)
    if (selectedChannel !== channel || snapshot.channel !== channel) throw new Error('Conversation changed.')
    for (const message of snapshot.messages) for (const image of message.images ?? []) imageSources.add(image.src)
    return snapshot
  })
  ipcMain.handle('slack:conversation-image', async (event, source: unknown) => {
    if (!ownRenderer(event) || typeof source !== 'string' || !imageSources.has(source)) throw new Error('Image is not in the active Slack timeline.')
    const url = new URL(source)
    if (url.protocol !== 'https:' || !['slack.com', 'slack-edge.com', 'slack-files.com'].some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('Unsupported image host')
    const cached = imageCache.get(source)
    if (cached) return cached
    const response = await slackSession.fetch(source, { credentials: 'include' })
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? ''
    if (!response.ok || !/^image\/(png|jpeg|gif|webp|avif)$/.test(contentType)) throw new Error('Image preview unavailable')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Image is too large to preview')
    const image = `data:${contentType};base64,${bytes.toString('base64')}`
    if (imageCache.size >= 40) imageCache.delete(imageCache.keys().next().value!)
    imageCache.set(source, image)
    return image
  })
  ipcMain.handle('slack:signin', async (event) => {
    if (!ownRenderer(event)) throw new Error('Invalid IPC sender')
    await browserSignin.start()
    await slack.webContents.loadURL('https://app.slack.com/client')
  })
  ipcMain.handle('slack:hide', (event) => {
    if (!ownRenderer(event)) throw new Error('Invalid IPC sender')
    slackVisible = false
    layout()
    window.contentView.addChildView(ui)
    ui.webContents.focus()
  })
  layout()
  window.on('resize', layout)
  const external = (url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  }
  ui.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' } })
  ui.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin + '/')) { event.preventDefault(); external(url) }
  })
  slack.webContents.setWindowOpenHandler(() => {
    // Authentication popups stay in the isolated Slack profile.
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: {
      session: slackSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
    } } }
  })
  const savedTeam = configuredTeam || database.getMetadata<{ teamId: string }>('session')?.teamId
  void slack.webContents.loadURL(savedTeam ? `https://app.slack.com/client/${savedTeam}` : 'https://slack.com/signin')
    .catch((error) => { if (error.code !== 'ERR_ABORTED') console.warn('Could not load Slack', error.message) })
  slack.webContents.on('did-finish-load', () => { if (!slackVisible) ui.webContents.focus() })
  await ui.webContents.loadURL(origin)
  engine.start()
  app.on('before-quit', () => { browserSignin.stop() })
  window.on('closed', () => {
    if (!slack.webContents.isDestroyed()) slack.webContents.close()
    if (!ui.webContents.isDestroyed()) ui.webContents.close()
    server.close()
    void engine.stop().finally(() => { database.close(); app.quit() })
  })
  app.on('second-instance', () => { window.show(); window.focus() })
}
