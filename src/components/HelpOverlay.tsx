import { useStore } from '../store'

const SHORTCUT_GROUPS: { title: string; shortcuts: [string[], string][] }[] = [
  {
    title: 'Navigate',
    shortcuts: [
      [['J', '↓'], 'Next conversation'],
      [['K', '↑'], 'Previous conversation'],
      [['Enter', 'O'], 'Read conversation'],
      [['Esc'], 'Return to list, clear selection, or cancel'],
      [['Tab', '⇧ Tab'], 'Next or previous view'],
      [['1', '2', '3'], 'DMs, Channels, Done'],
    ],
  },
  {
    title: 'Triage',
    shortcuts: [
      [['E'], 'Mark done and read; in Done, restore to inbox'],
      [['M'], 'Mute or unmute conversation in Slack'],
      [['Z'], 'Undo last action'],
    ],
  },
  {
    title: 'Respond',
    shortcuts: [
      [['R'], 'Reply in conversation'],
      [['T'], 'Reply in thread of latest message'],
      [['U'], 'Open in Slack'],
      [['⇧ R'], 'Refresh'],
      [['?'], 'Show or hide this list'],
    ],
  },
]

export function HelpOverlay() {
  const toggleHelp = useStore((state) => state.toggleHelp)

  return (
    <div className="overlay" onClick={toggleHelp}>
      <div className="help" role="dialog" aria-label="Keyboard shortcuts" onClick={(event) => event.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <div className="help-groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.shortcuts.map(([keys, description]) => (
                  <div key={description} className="help-row">
                    <dt>
                      {keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
