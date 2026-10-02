import type { SlackFile } from '../src/slack/types.ts'
import type { Database } from './database.ts'
import { SlackError, type SlackClient } from './slack-client.ts'
import { toFile } from './slack-data.ts'

export class Files {
  private readonly pending = new Map<string, Promise<{ contentType: string; data: Uint8Array }>>()

  constructor(private readonly database: Database, private readonly client: Pick<SlackClient, 'call' | 'downloadFile'>) {}

  async image(id: string) {
    const cached = this.database.imagePreview(id)
    if (cached) return cached
    const pending = this.pending.get(id)
    if (pending) return pending
    const request = this.fetch(id).finally(() => this.pending.delete(id))
    this.pending.set(id, request)
    return request
  }

  private async fetch(id: string) {
    let file = this.database.file(id)
    if (!file) throw new SlackError('files.info', 'file_not_found')
    if (!file.mimetype || (!file.thumb_720 && !file.url_private)) {
      const result = await this.client.call<{ file: SlackFile }>('files.info', { file: id })
      file = toFile(result.file)
      this.database.cacheFile(file)
    }
    if (!file.mimetype?.startsWith('image/')) throw new SlackError('files.download', 'not_an_image')
    const url = file.mimetype === 'image/gif' ? file.url_private ?? file.thumb_720 : file.thumb_720 ?? file.url_private
    if (!url) throw new SlackError('files.download', 'preview_unavailable')
    const response = await this.client.downloadFile(url)
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'].includes(contentType)) {
      await response.body?.cancel()
      throw new SlackError('files.download', 'unsupported_image_type')
    }
    const data = new Uint8Array(await response.arrayBuffer())
    this.database.cacheImagePreview(id, contentType, data)
    return { contentType, data }
  }
}
