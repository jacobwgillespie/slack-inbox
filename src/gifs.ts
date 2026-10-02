export interface Gif {
  id: string
  title: string
  preview: string
  url: string
  width: number
  height: number
}

interface KlipyImage { url: string; width: number; height: number }
interface KlipyResponse {
  result: boolean
  data: {
    data: { id: number; title: string; file: { sm: { gif: KlipyImage }; hd: { gif: KlipyImage } } }[]
    current_page: number
    has_next: boolean
  }
}

export const gifsConfigured = Boolean(import.meta.env.VITE_KLIPY_API_KEY)

function customerId() {
  const key = 'slack-inbox-gif-customer'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(key, id)
  return id
}

export async function browseGifs(query: string, page: number, signal: AbortSignal) {
  if (!gifsConfigured) throw new Error('GIF search isn’t available yet.')
  const url = new URL(`https://api.klipy.com/api/v1/${import.meta.env.VITE_KLIPY_API_KEY}/gifs/${query ? 'search' : 'trending'}`)
  url.search = new URLSearchParams({
    per_page: '24', page: String(page), customer_id: customerId(),
    ...(query ? { q: query } : {}),
  }).toString()
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many GIF searches. Please try again in a moment.' : 'Could not load GIFs. Please try again.')
  const result = await response.json() as KlipyResponse
  if (!result.result) throw new Error('Could not load GIFs. Please try again.')
  return {
    gifs: result.data.data.map((gif): Gif => ({
      id: String(gif.id), title: gif.title || 'GIF', preview: gif.file.sm.gif.url,
      url: gif.file.hd.gif.url,
      width: gif.file.hd.gif.width, height: gif.file.hd.gif.height,
    })),
    nextPage: result.data.current_page + 1,
    hasMore: result.data.has_next,
  }
}
