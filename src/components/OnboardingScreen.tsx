import { useRuntime, useUsers } from '../data'
import { useEffect, useRef } from 'react'
import { CheckIcon, ClockIcon, ThreadIcon } from './Icons'

export function OnboardingScreen({ onGetStarted }: { onGetStarted: () => void }) {
  const { session } = useRuntime()
  const users = useUsers()
  const user = session ? users[session.userId] : undefined
  const name = user?.firstName || user?.displayName.trim()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  return (
    <dialog ref={dialog} className="onboarding" aria-labelledby="onboarding-title"
      onCancel={(event) => { event.preventDefault(); onGetStarted() }}>
      <div className="onboarding-content">
        <img className="onboarding-app-icon" src="/icon.png" alt="Slack Inbox" />
        <h1 id="onboarding-title">Welcome{name ? `, ${name}` : ''}</h1>
        <p className="onboarding-intro">
          Slack Inbox sorts your conversations into three lists.
        </p>
        <div className="onboarding-steps">
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><ThreadIcon /></div>
            <div><h2>Inbox</h2>
              <p>Conversations with new messages appear here.</p></div>
          </section>
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><ClockIcon /></div>
            <div><h2>Later</h2>
              <p>Press <kbd>L</kbd> to save a message for later.</p></div>
          </section>
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><CheckIcon /></div>
            <div><h2>Done</h2>
              <p>Press <kbd>E</kbd> to mark a conversation as done.</p></div>
          </section>
        </div>
        <footer className="onboarding-footer">
          <button className="onboarding-start" onClick={onGetStarted}>Get started</button>
        </footer>
      </div>
    </dialog>
  )
}
