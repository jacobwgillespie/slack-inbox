import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const source = new URL('../assets/icon-source.png', import.meta.url)
const publicDir = new URL('../public/', import.meta.url)
await mkdir(publicDir, { recursive: true })

await sharp(fileURLToPath(source)).resize(1024, 1024).png().toFile(fileURLToPath(new URL('icon.png', publicDir)))

if (process.platform === 'darwin') {
  const temporary = await mkdtemp(join(tmpdir(), 'slack-inbox-icons-'))
  const iconset = join(temporary, 'icon.iconset')
  try {
    await mkdir(iconset)
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        await sharp(fileURLToPath(source)).resize(size * scale, size * scale).png()
          .toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', fileURLToPath(new URL('../assets/icon.icns', import.meta.url))])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
