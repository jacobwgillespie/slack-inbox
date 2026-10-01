import { useEffect, useState } from 'react'
import { useTyping } from '../typing'
import { useFormatContext } from '../hooks'

export function TypingDots() {
  return <span className="typing-dots" aria-label="Typing"><span /><span /><span /></span>
}

export function TypingIndicator({ channel }: { channel: string }) {
  const typing = useTyping(channel)
  const { users } = useFormatContext()
  const names = typing.map((id) => users[id]?.displayName ?? 'Someone')
  const text = names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names.join(' and ')} are typing` : names.length > 2 ? `${names.slice(0, 2).join(', ')} and others are typing` : ''
  const [lastText, setLastText] = useState('')
  useEffect(() => { if (text) setLastText(text) }, [text])
  return <div className={`typing-label${text ? ' active' : ''}`} role="status" aria-live="polite" aria-hidden={!text}>
    {text || lastText}
  </div>
}
