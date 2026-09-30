import type { Conversation } from '../slack/types'
import { HashIcon, LockIcon, PeopleIcon } from './Icons'

export function Avatar({ url, name, size = 'medium' }: { url?: string; name: string; size?: 'small' | 'medium' }) {
  if (url) return <img className={`avatar avatar-${size}`} src={url} alt="" />
  return (
    <span className={`avatar avatar-${size} avatar-initial`} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

interface ConversationIconProps {
  conversation: Conversation
  label: string
  avatar?: string
}

export function ConversationIcon({ conversation, label, avatar }: ConversationIconProps) {
  if (conversation.kind === 'dm') return <Avatar url={avatar} name={label} />
  const icon = { channel: <HashIcon />, private: <LockIcon />, group: <PeopleIcon /> }[conversation.kind]
  return <span className="avatar avatar-medium avatar-symbol">{icon}</span>
}
