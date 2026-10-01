export interface ImagePreview { source: string; width: number; height: number }
const previews = new Map<string, ImagePreview>()
const imageLoads = new Map<string, Promise<ImagePreview>>()

export function cachedImagePreview(source: string) { return previews.get(source) }

export function loadImagePreview(source: string): Promise<ImagePreview> {
  const cached = previews.get(source)
  if (cached) return Promise.resolve(cached)
  const pending = imageLoads.get(source)
  if (pending) return pending
  const promise = (async () => {
    const data = await window.slackDesktop.readImage(source)
    const image = new Image()
    image.src = data
    await image.decode()
    const preview = { source: data, width: image.naturalWidth, height: image.naturalHeight }
    if (previews.size >= 40) previews.delete(previews.keys().next().value!)
    previews.set(source, preview)
    return preview
  })().finally(() => imageLoads.delete(source))
  imageLoads.set(source, promise)
  return promise
}
