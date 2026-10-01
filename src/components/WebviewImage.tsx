import { useEffect, useState } from 'react'
import type { WebviewMessage } from '../slack/webview'

export function WebviewImage({ image }: { image: NonNullable<WebviewMessage['images']>[number] }) {
  const [source, setSource] = useState<string>()
  const [size, setSize] = useState<{ width: number; height: number }>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (source) return
    let cancelled = false
    void window.slackDesktop?.readImage(image.src).then(async (data) => {
      const preview = new Image()
      preview.src = data
      await preview.decode()
      if (!cancelled) {
        setSize({ width: preview.naturalWidth, height: preview.naturalHeight })
        setSource(data)
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
