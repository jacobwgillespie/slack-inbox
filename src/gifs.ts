export interface Gif {
  id: string
  title: string
  preview: string
  url: string
  width: number
  height: number
}

interface GiphyImage { url: string; width: string; height: string }
interface GiphyResponse {
  data: { id: string; title: string; images: { fixed_width: GiphyImage; original: GiphyImage } }[]
  pagination: { offset: number; count: number; total_count: number }
}

export const gifsConfigured = Boolean(import.meta.env.VITE_GIPHY_API_KEY)

export async function browseGifs(query: string, offset: number, signal: AbortSignal) {
  if (!gifsConfigured) throw new Error('GIF search isn’t available yet.')
  const url = new URL(`https://api.giphy.com/v1/gifs/${query ? 'search' : 'trending'}`)
  url.search = new URLSearchParams({
    api_key: import.meta.env.VITE_GIPHY_API_KEY,
    limit: '24', offset: String(offset), rating: 'pg-13',
    ...(query ? { q: query } : {}),
  }).toString()
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many GIF searches. Please try again in a moment.' : 'Could not load GIFs. Please try again.')
  const result = await response.json() as GiphyResponse
  return {
    gifs: result.data.map((gif): Gif => ({
      id: gif.id, title: gif.title || 'GIF', preview: gif.images.fixed_width.url,
      url: gif.images.original.url,
      width: Number(gif.images.original.width), height: Number(gif.images.original.height),
    })),
    nextOffset: result.pagination.offset + result.pagination.count,
    hasMore: result.pagination.offset + result.pagination.count < result.pagination.total_count,
  }
}
