import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { CheckIcon, ClockIcon, ThreadIcon } from './Icons'

export function OnboardingScreen({ onGetStarted }: { onGetStarted: () => void }) {
  const name = useStore((state) => state.session
    ? state.users[state.session.userId]?.displayName.trim()
    : undefined)
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
          Slack Inbox helps you manage your Slack conversations and focus on what’s important.
          There are three lists:
        </p>
        <div className="onboarding-steps">
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><ThreadIcon /></div>
            <div><h2>Inbox</h2>
              <p>Channels and direct messages, ordered by latest activity.</p></div>
          </section>
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><ClockIcon /></div>
            <div><h2>Later</h2>
              <p>Messages you’ve saved for later in Slack.</p></div>
          </section>
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><CheckIcon /></div>
            <div><h2>Done</h2>
              <p>Conversations you’ve marked done. New activity returns them to Inbox.</p></div>
          </section>
        </div>
        <footer className="onboarding-footer">
          <button className="onboarding-start" onClick={onGetStarted}>Get started</button>
        </footer>
      </div>
    </dialog>
  )
}
