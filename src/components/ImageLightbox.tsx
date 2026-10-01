import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { CloseIcon } from './Icons'

interface LightboxImage { source: string; title: string }

const useLightbox = create<{ image?: LightboxImage }>(() => ({}))
export const openImageLightbox = (source: string, title: string) => useLightbox.setState({ image: { source, title } })
const closeLightbox = () => useLightbox.setState({ image: undefined })

export function ImageLightbox() {
  const image = useLightbox((state) => state.image)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!image || !element) return
    element.showModal()
    return () => element.close()
  }, [image])

  return (
    <dialog ref={dialog} className="image-lightbox" aria-label={image?.title || 'Image preview'}
      onCancel={(event) => { event.preventDefault(); closeLightbox() }}
      onClick={(event) => { if (event.target === event.currentTarget) closeLightbox() }}
      onKeyDown={(event) => event.stopPropagation()}>
      {image && <LightboxContents key={image.source} image={image} />}
    </dialog>
  )
}

function LightboxContents({ image }: { image: LightboxImage }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <>
      <button className="icon-button lightbox-close" onClick={closeLightbox} aria-label="Close image" title="Close (Esc)"><CloseIcon /></button>
      <figure>
        {!loaded && <p role="status" className="muted">{failed ? 'Image unavailable' : 'Loading image…'}</p>}
        <img src={image.source} alt={image.title} hidden={failed} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
        {image.title && <figcaption>{image.title}</figcaption>}
      </figure>
    </>
  )
}
