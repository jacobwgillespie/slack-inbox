import { commands } from '../commands'
import { useStore } from '../store'

export function Toast() {
  const toast = useStore((state) => state.toast)
  const { undo, dismissToast } = commands
  if (!toast) return null

  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      <span>{toast.message}</span>
      {toast.undo && (
        <button className="link-button" onClick={undo}>
          Undo <kbd>Z</kbd>
        </button>
      )}
      <button className="link-button subtle" onClick={dismissToast} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
