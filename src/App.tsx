import { useState } from 'react'
import { useCacheSync } from './useCachedConversation'
import { DesktopSlack } from './components/DesktopSlack'
import { Detail } from './components/Detail'
import { Header } from './components/Header'
import { HelpOverlay } from './components/HelpOverlay'
import { SidebarFooter } from './components/SidebarFooter'
import { ItemList } from './components/ItemList'
import { ImageLightbox } from './components/ImageLightbox'
import { SetupScreen } from './components/SetupScreen'
import { OnboardingScreen } from './components/OnboardingScreen'
import { useInboxSync, useKeyboardShortcuts, useSelectionRepair } from './hooks'
import { useStore } from './store'

export function App() {
  const status = useStore((state) => state.status)
  const helpOpen = useStore((state) => state.helpOpen)
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => localStorage.getItem('slack-inbox-onboarding-complete') !== 'true',
  )
  useCacheSync()
  useInboxSync()
  useKeyboardShortcuts(!onboardingOpen)
  useSelectionRepair()

  if (status === 'error') return <><DesktopSlack /><SetupScreen /></>

  return (
    <div className="app">
      <DesktopSlack />
      <main className="workspace">
        <aside className="sidebar" aria-label="Inbox sidebar">
          <Header />
          <ItemList />
          <SidebarFooter onWelcome={() => setOnboardingOpen(true)} />
        </aside>
        <Detail />
      </main>
      {helpOpen && <HelpOverlay />}
      <ImageLightbox />
      {onboardingOpen && <OnboardingScreen onGetStarted={() => {
        localStorage.setItem('slack-inbox-onboarding-complete', 'true')
        setOnboardingOpen(false)
      }} />}
    </div>
  )
}
