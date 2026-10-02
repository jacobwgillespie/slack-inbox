import { useEffect, useState } from 'react'
import type { User } from './slack/types'

export function useCustomStatus(user?: User): boolean {
  const [now, setNow] = useState(Date.now())
  const expiration = user?.statusExpiration
  useEffect(() => {
    if (!expiration || expiration * 1000 <= now) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, expiration * 1000 - Date.now())))
    return () => clearTimeout(timer)
  }, [expiration, now])
  return Boolean(user && (user.statusText || user.statusEmoji) && (!expiration || expiration * 1000 > Date.now()))
}
