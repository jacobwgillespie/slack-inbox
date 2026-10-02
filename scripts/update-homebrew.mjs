import { readFile, writeFile } from 'node:fs/promises'

const response = await fetch('https://api.github.com/repos/jacobwgillespie/slack-inbox/releases/latest', {
  headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
})
if (!response.ok) throw new Error(`Could not read latest release: ${response.status}`)
const release = await response.json()
if (process.env.RELEASE_TAG && release.tag_name !== process.env.RELEASE_TAG) {
  console.log('Skipping release that is no longer the latest stable version')
  process.exit(0)
}
const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1]
if (!version || release.draft || release.prerelease) throw new Error('Expected a published stable release')

const checksum = (arch) => {
  const asset = release.assets.find((asset) => asset.name === `Slack-Inbox-${version}-${arch}.dmg`)
  const hash = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest)?.[1]
  if (asset?.state !== 'uploaded' || !hash) throw new Error(`Missing DMG or SHA-256 digest for ${arch}`)
  return hash
}
const path = 'homebrew-tap/Casks/slack-inbox.rb'
const previous = await readFile(path, 'utf8')
const stanza = /  version "[^"]+"\n  sha256 arm:   "[a-f0-9]{64}",\n         intel: "[a-f0-9]{64}"/
if (!stanza.test(previous)) throw new Error('Cask version and checksum stanza not found')
const updated = previous.replace(stanza,
  `  version "${version}"\n  sha256 arm:   "${checksum('arm64')}",\n         intel: "${checksum('x64')}"`)
if (updated !== previous) await writeFile(path, updated)
console.log(`Homebrew cask matches Slack Inbox ${version}`)
