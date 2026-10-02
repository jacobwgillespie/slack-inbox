import { spawn, execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let executable = require('electron')
let args = [join(root, 'electron-dist/main.cjs')]

if (process.platform === 'darwin') {
  const bundle = join(root, '.dev', 'Slack Inbox Dev.app')
  const marker = join(root, '.dev', 'electron-version')
  const version = `${require('electron/package.json').version}-${process.arch}`
  const previousVersion = await readFile(marker, 'utf8').catch(() => '')
  if (previousVersion !== version) {
    await mkdir(join(root, '.dev'), { recursive: true })
    await rm(bundle, { recursive: true, force: true })
    await cp(resolve(executable, '../../..'), bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
    const plist = join(bundle, 'Contents', 'Info.plist')
    for (const [key, value] of Object.entries({
      CFBundleDisplayName: 'Slack Inbox Dev',
      CFBundleName: 'Slack Inbox Dev',
      CFBundleIdentifier: 'com.jacobwgillespie.slack-inbox.dev',
    })) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
    }
    await cp(join(root, 'assets/icon.icns'), join(bundle, 'Contents/Resources/electron.icns'))
    // Embed the checkout's entry point so Finder/Dock launches need no arguments.
    await symlink(root, join(bundle, 'Contents/Resources/app'))
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' })
    await writeFile(marker, version)
  }
  // Keep the Electron executable name so app.isPackaged stays false in development.
  executable = join(bundle, 'Contents/MacOS/Electron')
  args = []
}

if (!process.argv.includes('--prepare-only')) {
  const child = spawn(executable, args, { cwd: root, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', (error) => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
}
