import { useEffect, useState } from 'react'
import type { WebviewMessage } from '../slack/webview'
import { cachedImagePreview, loadImagePreview } from '../imagePreview'

export function WebviewImage({ image }: { image: NonNullable<WebviewMessage['images']>[number] }) {
  const [source, setSource] = useState(() => cachedImagePreview(image.src)?.source)
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(() => cachedImagePreview(image.src))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (source) return
    let cancelled = false
    void loadImagePreview(image.src).then((preview) => {
      if (!cancelled) {
        setSize(preview)
        setSource(preview.source)
      }
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [image.src, source])
  const width = size?.width ?? image.width ?? 320
  const height = size?.height ?? image.height ?? 180
  const scale = Math.min(1, 480 / width, 360 / height)
  return <a className="file-image webview-image" style={{ width: width * scale, aspectRatio: `${width} / ${height}` }} href={image.src} target="_blank" rel="noreferrer">
    {source ? <img src={source} alt={image.alt} width={width} height={height} /> : <span>{failed ? 'Preview unavailable' : 'Loading image…'}</span>}
  </a>
}
