import { useState } from 'react'
import type { SlackFile } from '../slack/types'
import { openImageLightbox } from './ImageLightbox'

export function isImageFile(file: SlackFile): boolean {
  return Boolean(file.mimetype?.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i.test(file.name ?? file.title ?? ''))
}

export function FileAttachment({ file }: { file: SlackFile }) {
  const [failed, setFailed] = useState(false)
  const title = file.title ?? file.name ?? 'File'
  const image = isImageFile(file)
  const source = `/local/image?${new URLSearchParams({ file: file.id })}`
  if (image && !failed) {
    return (
      <button className="file-image" onClick={() => openImageLightbox(source, title)} title={title} aria-label={`Open image: ${title}`}>
        <img
          src={source}
          alt={title}
          width={file.original_w}
          height={file.original_h}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </button>
    )
  }
  return <a className="file" href={file.permalink} target="_blank" rel="noreferrer" title={failed ? 'Preview unavailable. Open in Slack.' : undefined}>{title}</a>
}
