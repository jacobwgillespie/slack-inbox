import type { Presence } from '../slack/types'

export function PresenceDot({ presence }: { presence?: Presence }) {
  if (!presence) return null
  const label = presence === 'active' ? 'Active' : 'Away'
  return <span className={`presence-dot presence-${presence}`} role="img" aria-label={label} title={label} />
}
