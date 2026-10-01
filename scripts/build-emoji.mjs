import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

// Keep only shortcodes and Unicode sequences from emoji-data's full dataset.
const require = createRequire(import.meta.url)
const data = JSON.parse(await readFile(require.resolve('emoji-datasource/emoji.json'), 'utf8'))
const emoji = {}
const unicode = (sequence) => String.fromCodePoint(...sequence.split('-').map((point) => parseInt(point, 16)))
for (const entry of data) {
  for (const name of entry.short_names) {
    emoji[name] = unicode(entry.unified)
    for (const [tones, variant] of Object.entries(entry.skin_variations ?? {})) {
      const suffix = tones.split('-').map((tone) => `skin-tone-${parseInt(tone, 16) - 0x1f3fb + 2}`).join('::')
      emoji[`${name}::${suffix}`] = unicode(variant.unified)
    }
  }
}
await writeFile(new URL('../src/slack/emoji-data.json', import.meta.url), JSON.stringify(emoji) + '\n')
