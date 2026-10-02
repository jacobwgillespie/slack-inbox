import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const CheckIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
)

export const CloseIcon = () => (
  <Icon><path d="M6 6l12 12M18 6L6 18" /></Icon>
)

export const HelpIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01" />
  </Icon>
)

export const LogoutIcon = () => (
  <Icon>
    <path d="M14 4h5v16h-5M15 12H3m5-5-5 5 5 5" />
  </Icon>
)

export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
)

export const PresenceIcon = ({ active }: { active: boolean }) => (
  <Icon><circle cx="12" cy="12" r="8.5" fill={active ? 'currentColor' : 'none'} /></Icon>
)

export const MuteIcon = () => (
  <Icon>
    <path d="M11 5L6.5 9H3v6h3.5L11 19z" />
    <path d="M16 9.5l5 5M21 9.5l-5 5" />
  </Icon>
)

export const BugIcon = () => (
  <Icon>
    <path d="M8 8h8v7a4 4 0 0 1-8 0zM9 8V6a3 3 0 0 1 6 0v2M12 12v7" />
    <path d="M8 10 5 7M16 10l3-3M8 13H4M16 13h4M8 16l-3 3M16 16l3 3" />
  </Icon>
)

export const RefreshIcon = () => (
  <Icon>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
    <path d="M20 20v-4h-4" />
  </Icon>
)

export const DownloadIcon = () => (
  <Icon>
    <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />
  </Icon>
)

export const HashIcon = () => (
  <Icon>
    <path d="M9 4L7 20M17 4l-2 16M4.5 9h16M3.5 15h16" />
  </Icon>
)

export const LockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
)

export const PeopleIcon = () => (
  <Icon>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18.5 14.5A6.5 6.5 0 0 1 21.5 20" />
  </Icon>
)

export const SwapIcon = () => (
  <Icon>
    <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />
  </Icon>
)

export const ThreadIcon = () => (
  <Icon>
    <path d="M4 5h16v10H9l-5 4z" />
  </Icon>
)

export const ReplyIcon = () => (
  <Icon>
    <path d="M9 5L3 11l6 6M3 11h11a7 7 0 0 1 7 7" />
  </Icon>
)

export const ArrowUpIcon = () => (
  <Icon>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Icon>
)

export const PlusIcon = () => (
  <Icon><path d="M12 5v14M5 12h14" /></Icon>
)

export const ArrowLeftIcon = () => (
  <Icon>
    <path d="M19 12H5M12 5l-7 7 7 7" />
  </Icon>
)

export const BookmarkIcon = () => (
  <Icon><path d="M6 4h12v17l-6-4-6 4z" /></Icon>
)

export const ReactionIcon = () => (
  <Icon>
    <path d="M20 13a8 8 0 1 1-9-9M8 14a4 4 0 0 0 8 0M8.5 9h.01M14.5 9h.01M19 3v6M16 6h6" />
  </Icon>
)
