import { useEffect, useState } from 'react'
import type { WebviewMessage } from '../slack/webview'

export function WebviewImage({ image }: { image: NonNullable<WebviewMessage['images']>[number] }) {
  const [source, setSource] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.slackDesktop?.readImage(image.src).then((data) => {
      if (!cancelled) setSource(data)
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [image.src])
  return <a className="file-image" href={image.src} target="_blank" rel="noreferrer">
    {source ? <img src={source} alt={image.alt} width={image.width} height={image.height} /> : <span>{failed ? 'Preview unavailable' : 'Loading image…'}</span>}
  </a>
}
