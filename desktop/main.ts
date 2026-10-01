import { app, BaseWindow, WebContentsView, ipcMain, session, shell } from 'electron'
import { createServer } from 'node:http'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { Database } from '../server/database.ts'
import { SlackClient, SlackError, type SlackCredentials } from '../server/slack-client.ts'
import { SyncEngine } from '../server/sync.ts'
import { localApi } from '../server/routes.ts'
import { configuredSession } from './configured-session.ts'
import { BrowserSignin } from './browser-signin.ts'
import { ConversationCollector } from './conversation-collector.ts'
import { observeSlack } from './slack-session.ts'

app.setName('Slack Inbox')
if (!app.requestSingleInstanceLock()) app.quit()
else void start().catch((error) => { console.error('Could not start Slack Inbox', error); app.quit() })

async function start() {
  await app.whenReady()
  const root = resolve(__dirname, '..')
  if (process.platform === 'darwin') app.dock?.setIcon(join(root, 'dist', 'icon.png'))
  const slackSession = session.fromPartition('persist:slack')
  slackSession.setUserAgent(app.userAgentFallback.replace(/\s(?:Electron|slack-inbox|SlackInbox)\/[^ ]+/gi, ''))
  slackSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
  slackSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
  const browserSignin = new BrowserSignin(join(app.getPath('userData'), 'signin-chrome'), slackSession)
  const credentials: SlackCredentials = { origin: 'https://slack.com' }
  const logoutMarker = join(app.getPath('userData'), 'disable-configured-session')
  const skipConfiguredSession = await access(logoutMarker).then(() => true, () => false)
  const configuredTeam = skipConfiguredSession ? undefined : await configuredSession(root, slackSession, credentials)
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
    preload: join(__dirname, 'slack-preload.cjs'),
    session: slackSession, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, focusOnNavigation: false,
  } })
  const collectorView = new WebContentsView({ webPreferences: {
    preload: join(__dirname, 'slack-preload.cjs'), additionalArguments: ['--slack-background-collector'],
    session: slackSession, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, focusOnNavigation: false,
  } })
  collectorView.webContents.setUserAgent(slackSession.getUserAgent())
  collectorView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.contentView.addChildView(collectorView)
  slack.webContents.setUserAgent(slackSession.getUserAgent())
  window.contentView.addChildView(slack)
  window.contentView.addChildView(ui)
  slack.setVisible(true)
  observeSlack(slack, credentials, engine)
  const layout = () => {
    const { width, height } = window.getContentBounds()
    const toolbarHeight = process.platform === 'darwin' ? 68 : 44
    ui.setBounds({ x: 0, y: 0, width, height: slackVisible ? toolbarHeight : height })
    const bounds = { x: 0, y: toolbarHeight, width, height: Math.max(0, height - toolbarHeight) }
    slack.setBounds(bounds)
    collectorView.setBounds(bounds)
  }
  let slackVisible = false
  const showSlack = async (channel?: string) => {
    const team = database.getMetadata<{ teamId: string }>('session')?.teamId
    slackVisible = true
    slack.webContents.send('slack:read-markers-enabled', true)
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
  const validChannel = (channel: unknown): channel is string => typeof channel === 'string' && /^[CDG][A-Z0-9]+$/.test(channel)
  let composer: { channel: string; generation: number } | undefined
  let composerGeneration = 0
  const bindComposer = () => {
    if (!slack.webContents.isDestroyed()) slack.webContents.send('slack:composer-bind', composer)
  }
  ipcMain.handle('slack:composer-follow', (event, channel: unknown) => {
    if (!ownRenderer(event) || !validChannel(channel)) throw new Error('Invalid composer')
    const team = database.getMetadata<{ teamId: string }>('session')?.teamId
    if (!team) return
    composer = { channel, generation: ++composerGeneration }
    const destination = `https://app.slack.com/client/${team}/${channel}`
    const generation = composer.generation
    bindComposer()
    if (slack.webContents.getURL().split('?')[0] !== destination) void (async () => {
      const clicked = slack.webContents.getURL().startsWith('https://app.slack.com/client/') && await slack.webContents.executeJavaScript(`(() => {
        const destination = ${JSON.stringify(destination)};
        const link = [...document.querySelectorAll('.p-channel_sidebar a[href]')].find(link => link.href.split('?')[0] === destination);
        if (!link) return false;
        link.click(); return true;
      })()`)
      if (!clicked && composer?.generation === generation) await slack.webContents.loadURL(destination)
    })().catch((error) => {
      if (error.code !== 'ERR_ABORTED') console.warn('Could not follow Slack composer', error.message)
    })
    return generation
  })
  ipcMain.handle('slack:composer-stop', (event, generation: unknown) => {
    if (!ownRenderer(event)) throw new Error('Invalid IPC sender')
    if (composer?.generation !== generation) return
    composer = undefined
    bindComposer()
  })
  ipcMain.handle('slack:composer-action', (event, generation: unknown, action: import('../src/slack/composer').ComposerAction) => {
    if (!ownRenderer(event) || !action || !['input', 'key', 'click'].includes(action.type)) throw new Error('Invalid composer action')
    if (!composer || composer.generation !== generation) return
    slack.webContents.send('slack:composer-action', generation, action)
  })
  ipcMain.on('slack:composer-changed', (event, draft: import('../src/slack/composer').ComposerSnapshot) => {
    if (event.sender !== slack.webContents || !event.senderFrame?.url.startsWith('https://app.slack.com/client/') ||
        !composer || draft?.generation !== composer.generation || draft.channel !== composer.channel || typeof draft.html !== 'string') return
    if (!slackVisible && draft.source === 'inbox') ui.webContents.focus()
    ui.webContents.send('slack:composer-changed', draft)
  })
  slack.webContents.on('dom-ready', bindComposer)
  const cacheChanged = (channel?: string) => {
    if (!ui.webContents.isDestroyed()) ui.webContents.send('slack:cache-changed', channel)
  }
  const collector = new ConversationCollector(collectorView.webContents, database, engine, cacheChanged)
  const unsubscribeCache = engine.subscribe(() => cacheChanged())
  // Background navigation must not mark conversations read.
  slackSession.webRequest.onBeforeRequest({ urls: ['https://*.slack.com/api/*'] }, (details, callback) => {
    const method = new URL(details.url).pathname.split('/').pop()
    const mark = ['conversations.mark', 'im.mark', 'mpim.mark', 'channels.mark', 'groups.mark'].includes(method ?? '')
    callback({ cancel: mark && (details.webContentsId === collectorView.webContents.id || (details.webContentsId === slack.webContents.id && !slackVisible)) })
  })
  ipcMain.on('slack:timeline-changed', (event, channel: unknown) => {
    if (event.sender !== collectorView.webContents || !event.senderFrame?.url.startsWith('https://app.slack.com/client/') || !validChannel(channel)) return
    collector.notify(channel)
  })
  ipcMain.handle('slack:cache-read', (event, channel: unknown, options: { before?: string; after?: string } | null = {}) => {
    if (!ownRenderer(event) || (channel != null && !validChannel(channel))) throw new Error('Invalid conversation')
    options ??= {}
    if ([options.before, options.after].some((ts) => ts !== undefined && (typeof ts !== 'string' || !/^\d+\.\d+$/.test(ts)))) throw new Error('Invalid message cursor')
    const channels = channel ? [channel] : database.conversationSummaries().map((conversation) => conversation.id)
    return channels.map((id) => ({ ...database.cachedConversation(id, options.before, options.after), syncing: collector.isSyncing(id) }))
  })
  ipcMain.handle('slack:cache-watch', (event, channels: unknown, selected: unknown) => {
    if (!ownRenderer(event) || !Array.isArray(channels) || !channels.every(validChannel) || (selected !== undefined && !validChannel(selected))) throw new Error('Invalid conversations')
    collector.watch(channels, selected as string | undefined)
  })
  ipcMain.handle('slack:cache-refresh', (event, channel: unknown, older: unknown) => {
    if (!ownRenderer(event) || !validChannel(channel) || typeof older !== 'boolean') throw new Error('Invalid conversation')
    collector.refresh(channel, older)
  })
  ipcMain.handle('slack:conversation-image', async (event, source: unknown) => {
    if (!ownRenderer(event) || typeof source !== 'string' || !database.webviewImageKnown(source)) throw new Error('Image is not in the cached Slack messages.')
    const url = new URL(source)
    if (url.protocol !== 'https:' || !['slack.com', 'slack-edge.com', 'slack-files.com'].some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('Unsupported image host')
    const cached = database.imagePreview(source)
    if (cached) return `data:${cached.contentType};base64,${Buffer.from(cached.data).toString('base64')}`
    const response = await slackSession.fetch(source, { credentials: 'include' })
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? ''
    if (!response.ok || !/^image\/(png|jpeg|gif|webp|avif)$/.test(contentType)) throw new Error('Image preview unavailable')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Image is too large to preview')
    const image = `data:${contentType};base64,${bytes.toString('base64')}`
    database.cacheImagePreview(source, contentType, bytes)
    return image
  })
  ipcMain.handle('slack:signin', async (event) => {
    if (!ownRenderer(event)) throw new Error('Invalid IPC sender')
    await browserSignin.start()
    await slack.webContents.loadURL('https://app.slack.com/client')
    await collectorView.webContents.loadURL('https://app.slack.com/client')
  })
  ipcMain.handle('slack:logout', async (event) => {
    if (!ownRenderer(event)) throw new Error('Invalid IPC sender')
    // Do not re-import the development credentials after an explicit logout.
    await writeFile(logoutMarker, '')
    await browserSignin.stop()
    collector.stop()
    slack.webContents.close()
    collectorView.webContents.close()
    await engine.stop()
    credentials.sessionToken = undefined
    await slackSession.clearStorageData()
    await slackSession.clearCache()
    await slackSession.cookies.flushStore()
    await rm(join(app.getPath('userData'), 'signin-chrome'), { recursive: true, force: true })
    database.setMetadata('signed-out', true)
    app.relaunch()
    setTimeout(() => app.exit(0), 100)
  })
  ipcMain.handle('slack:hide', (event) => {
    if (!ownRenderer(event)) throw new Error('Invalid IPC sender')
    slackVisible = false
    slack.webContents.send('slack:read-markers-enabled', false)
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
  const savedTeam = database.getMetadata<boolean>('signed-out') ? undefined : configuredTeam || database.getMetadata<{ teamId: string }>('session')?.teamId
  void slack.webContents.loadURL(savedTeam ? `https://app.slack.com/client/${savedTeam}` : 'https://slack.com/signin')
    .catch((error) => { if (error.code !== 'ERR_ABORTED') console.warn('Could not load Slack', error.message) })
  slack.webContents.on('dom-ready', () => slack.webContents.send('slack:read-markers-enabled', slackVisible))
  slack.webContents.on('did-finish-load', () => { if (!slackVisible) ui.webContents.focus() })
  if (savedTeam) void collectorView.webContents.loadURL(`https://app.slack.com/client/${savedTeam}`).catch(() => {})
  await ui.webContents.loadURL(origin)
  engine.start()
  app.on('before-quit', () => { browserSignin.stop() })
  window.on('closed', () => {
    collector.stop()
    unsubscribeCache()
    if (!collectorView.webContents.isDestroyed()) collectorView.webContents.close()
    if (!slack.webContents.isDestroyed()) slack.webContents.close()
    if (!ui.webContents.isDestroyed()) ui.webContents.close()
    server.close()
    void engine.stop().finally(() => { database.close(); app.quit() })
  })
  app.on('second-instance', () => { window.show(); window.focus() })
}
