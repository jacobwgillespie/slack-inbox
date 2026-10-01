import { app, dialog, Menu, MenuItem } from 'electron'
import { autoUpdater } from 'electron-updater'

export function setupUpdates() {
  if (!app.isPackaged || process.platform !== 'darwin') return
  let checking = false
  let downloaded = false

  const offerRestart = async () => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: 'An update is ready to install.',
      detail: 'Restart Slack Inbox to use the new version, or keep working and install it when you quit.',
      buttons: ['Restart to update', 'Later'],
      defaultId: 1,
      cancelId: 1,
    })
    if (response === 0) autoUpdater.quitAndInstall()
  }

  autoUpdater.on('error', (error) => console.warn('Could not update Slack Inbox', error.message))
  autoUpdater.on('update-downloaded', () => {
    downloaded = true
    void offerRestart()
  })

  const check = async (manual = false) => {
    if (checking) return
    if (downloaded) {
      if (manual) await offerRestart()
      return
    }
    checking = true
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
    }
  }

  const menu = Menu.getApplicationMenu()
  const appMenu = menu?.items[0]?.submenu
  if (menu && appMenu) {
    appMenu.insert(1, new MenuItem({ label: 'Check for Updates…', click: () => { void check(true) } }))
    Menu.setApplicationMenu(menu)
  }
  void check()
  const timer = setInterval(() => { void check() }, 4 * 60 * 60 * 1000)
  timer.unref()
  app.once('before-quit', () => clearInterval(timer))
}
