import { useState } from 'react'
import type { SlackFile } from '../slack/types'

export function isImageFile(file: SlackFile): boolean {
  return Boolean(file.mimetype?.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i.test(file.name ?? file.title ?? ''))
}

export function FileAttachment({ file }: { file: SlackFile }) {
  const [failed, setFailed] = useState(false)
  const title = file.title ?? file.name ?? 'File'
  const image = isImageFile(file)
  if (image && !failed) {
    return (
      <a className="file-image" href={file.permalink} target="_blank" rel="noreferrer" title={title}>
        <img
          src={`/local/image?${new URLSearchParams({ file: file.id })}`}
          alt={title}
          width={file.original_w}
          height={file.original_h}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </a>
    )
  }
  return <a className="file" href={file.permalink} target="_blank" rel="noreferrer" title={failed ? 'Preview unavailable. Open in Slack.' : undefined}>{title}</a>
}
