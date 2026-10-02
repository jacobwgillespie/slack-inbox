import { useEffect, useState } from 'react'
import { readPastedImage, type DraftImage } from '../composer-images'
import { CloseIcon } from './Icons'

export function ComposerImage({ image, disabled, onRemove }: { image: DraftImage; disabled: boolean; onRemove: () => void }) {
  const [source, setSource] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    let url: string | undefined
    void readPastedImage(image.id).then((blob) => {
      if (disposed) return
      url = URL.createObjectURL(blob)
      setSource(url)
    }).catch(() => { if (!disposed) setFailed(true) })
    return () => { disposed = true; if (url) URL.revokeObjectURL(url) }
  }, [image.id])
  return <div className="composer-gif composer-image">
    {source ? <img src={source} alt={image.name} /> : <span>{failed ? 'Image unavailable' : 'Loading image…'}</span>}
    <button type="button" aria-label={`Remove ${image.name}`} title="Remove image" disabled={disabled} onClick={onRemove}><CloseIcon /></button>
  </div>
}
