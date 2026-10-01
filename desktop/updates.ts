import { app, dialog, Menu, MenuItem } from 'electron'
import { autoUpdater } from 'electron-updater'

export function setupUpdates(onReady: (version: string) => void) {
  if (!app.isPackaged || process.platform !== 'darwin') return
  let checking = false
  let downloadedVersion: string | undefined
  const menuItem = new MenuItem({ label: 'Check for Updates…', click: () => { void check(true) } })
  const restart = () => { if (downloadedVersion) autoUpdater.quitAndInstall() }

  autoUpdater.on('error', (error) => console.warn('Could not update Slack Inbox', error.message))
  autoUpdater.on('update-available', () => { menuItem.label = 'Downloading Update…' })
  autoUpdater.on('download-progress', ({ percent }) => { menuItem.label = `Downloading Update… ${Math.floor(percent)}%` })
  autoUpdater.on('update-downloaded', ({ version }) => {
    downloadedVersion = version
    onReady(version)
  })

  const check = async (manual = false) => {
    if (checking) return
    if (downloadedVersion) {
      if (manual) restart()
      return
    }
    checking = true
    menuItem.enabled = false
    menuItem.label = 'Checking for Updates…'
    try {
      const result = await autoUpdater.checkForUpdates()
      if (manual && result && !result.isUpdateAvailable) {
        await dialog.showMessageBox({ type: 'info', message: 'Slack Inbox is up to date.', detail: `Version ${app.getVersion()}` })
      }
      await result?.downloadPromise
    } catch {
      if (manual) await dialog.showMessageBox({ type: 'error', message: 'Could not check for updates.', detail: 'Please try again later.' })
    } finally {
      checking = false
      menuItem.enabled = true
      menuItem.label = downloadedVersion ? 'Restart to Update…' : 'Check for Updates…'
    }
  }

  const menu = Menu.getApplicationMenu()
  const appMenu = menu?.items[0]?.submenu
  if (menu && appMenu) {
    appMenu.insert(1, menuItem)
    Menu.setApplicationMenu(menu)
  }
  void check()
  const timer = setInterval(() => { void check() }, 4 * 60 * 60 * 1000)
  timer.unref()
  app.once('before-quit', () => clearInterval(timer))
  return { get version() { return downloadedVersion }, restart }
}
