import { useEffect, useRef } from 'react'
import { CheckIcon, ClockIcon, ThreadIcon } from './Icons'

export function OnboardingScreen({ onGetStarted }: { onGetStarted: () => void }) {
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
        <div className="onboarding-mark"><ThreadIcon /></div>
        <p className="onboarding-eyebrow">WELCOME TO SLACK INBOX</p>
        <h1 id="onboarding-title">Less noise.<br />More breathing room.</h1>
        <p className="onboarding-intro">
          Work through your conversations, keep what needs another look,
          and clear away what’s finished.
        </p>
        <div className="onboarding-steps">
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><ThreadIcon /></div>
            <div><h2>Start in Inbox <kbd>1</kbd></h2>
              <p>Your channels and DMs, together. The latest activity rises to the top.</p></div>
          </section>
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><ClockIcon /></div>
            <div><h2>Keep it for Later <kbd>2</kbd></h2>
              <p>Messages you save for later in Slack live here, ready when you are.</p></div>
          </section>
          <section className="onboarding-step">
            <div className="onboarding-step-icon"><CheckIcon /></div>
            <div><h2>Clear it into Done <kbd>3</kbd></h2>
              <p>Hover a conversation and click the check, or press <kbd>E</kbd>.
                New activity brings it back to Inbox.</p></div>
          </section>
        </div>
        <footer className="onboarding-footer">
          <p>Move with <kbd>↑</kbd> <kbd>↓</kbd>. Press <kbd>?</kbd> for all shortcuts.</p>
          <button className="onboarding-start" onClick={onGetStarted}>Get started</button>
        </footer>
      </div>
    </dialog>
  )
}
