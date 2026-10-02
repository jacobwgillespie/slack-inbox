import { useRef, useState, type ImgHTMLAttributes } from 'react'

/** Keep a still frame mounted; only load the animated image while hovering. */
export function MessageImage({ gif = false, ...props }: ImgHTMLAttributes<HTMLImageElement> & { gif?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [stillSource, setStillSource] = useState<string>()
  const [hovered, setHovered] = useState(false)
  const animated = gif || /^data:image\/gif[;,]/i.test(props.src ?? '') || /\.gif(?:[?#]|$)/i.test(props.src ?? '')
  const ready = stillSource === props.src
  return <span className={`message-image${animated ? ' message-image-gif' : ''}`}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
    {animated && <canvas ref={canvas} className={props.className} hidden={!ready || hovered} role="img" aria-label={props.alt} />}
    {(!animated || !ready || hovered) && <img {...props} onLoad={(event) => {
      if (animated && !ready && canvas.current) {
        const image = event.currentTarget
        canvas.current.width = image.naturalWidth
        canvas.current.height = image.naturalHeight
        const context = canvas.current.getContext('2d')
        if (context) {
          context.drawImage(image, 0, 0)
          setStillSource(props.src)
        }
      }
      props.onLoad?.(event)
    }} />}
    {animated && <span className="gif-badge" aria-hidden="true">GIF</span>}
  </span>
}
