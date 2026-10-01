import { useEffect, useRef } from 'react'

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
        <h1 id="onboarding-title">Welcome</h1>
        <p className="onboarding-intro">
          Slack Inbox helps you manage your Slack conversations and focus on what’s important.
          There are three lists:
        </p>
        <div className="onboarding-steps">
          <section className="onboarding-step">
            <h2>Inbox</h2>
            <p>Channels and direct messages, ordered by latest activity.</p>
          </section>
          <section className="onboarding-step">
            <h2>Later</h2>
            <p>Messages you’ve saved for later in Slack.</p>
          </section>
          <section className="onboarding-step">
            <h2>Done</h2>
            <p>Conversations you’ve marked done. New activity returns them to Inbox.</p>
          </section>
        </div>
        <footer className="onboarding-footer">
          <button className="onboarding-start" onClick={onGetStarted}>Get started</button>
        </footer>
      </div>
    </dialog>
  )
}
