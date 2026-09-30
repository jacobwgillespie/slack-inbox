import { Detail } from './components/Detail'
import { Header } from './components/Header'
import { HelpOverlay } from './components/HelpOverlay'
import { ItemList } from './components/ItemList'
import { SetupScreen } from './components/SetupScreen'
import { Toast } from './components/Toast'
import { useInboxSync, useKeyboardShortcuts, useSelectionRepair } from './hooks'
import { useStore } from './store'

export function App() {
  const status = useStore((state) => state.status)
  const helpOpen = useStore((state) => state.helpOpen)
  useInboxSync()
  useKeyboardShortcuts()
  useSelectionRepair()

  if (status === 'error') return <SetupScreen />

  return (
    <div className="app">
      <Header />
      <main className="workspace">
        <ItemList />
        <Detail />
      </main>
      <Toast />
      {helpOpen && <HelpOverlay />}
    </div>
  )
}
