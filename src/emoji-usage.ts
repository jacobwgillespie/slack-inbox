const storageKey = 'emoji-acceptance-counts'

function readCounts(): Record<string, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    const counts: Record<string, number> = {}
    for (const [name, count] of Object.entries(stored)) {
      if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) counts[name] = count
    }
    return counts
  }
  catch { return {} }
}

export function prioritizeEmoji(names: string[], query: string): string[] {
  const counts = readCounts()
  return names.filter((name) => name.includes(query.toLowerCase()))
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
}

export function recordEmojiAcceptance(name: string) {
  const counts = readCounts()
  counts[name] = (counts[name] ?? 0) + 1
  try { localStorage.setItem(storageKey, JSON.stringify(counts)) }
  catch { /* Storage failures shouldn't prevent inserting an emoji. */ }
}
