import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { conversationLabel } from '../format'
import { useStore } from '../store'
import { ConversationIcon } from './Avatar'
import { CloseIcon } from './Icons'

export function ThreadSearch() {
  const directMessages = useStore((state) => state.directMessages)
  const channels = useStore((state) => state.channels)
  const users = useStore((state) => state.users)
  const session = useStore((state) => state.session)
  const close = () => useStore.getState().setSearchOpen(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const terms = query.trim().toLocaleLowerCase().replace(/^[#@]/, '').split(/\s+/).filter(Boolean)
  const results = Object.values({ ...directMessages, ...channels })
    .map((item) => {
      const label = conversationLabel(item.conversation, users, session)
      const user = users[item.conversation.userId ?? '']
      const searchable = [label, item.conversation.name, user?.handle, user?.firstName].join(' ').toLocaleLowerCase()
      return { item, label, user, searchable }
    })
    .filter(({ searchable }) => terms.every((term) => searchable.includes(term)))
    .sort((a, b) => a.label.localeCompare(b.label))
  const index = Math.min(selectedIndex, Math.max(0, results.length - 1))
  const selected = results[index]

  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    input.current?.focus()
    return () => element.close()
  }, [])

  useLayoutEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected?.item.id])

  return (
    <dialog ref={dialog} className="thread-search" aria-label="Search DMs and channels"
      onCancel={(event) => { event.preventDefault(); close() }}
      onClick={(event) => { if (event.target === event.currentTarget) close() }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setSelectedIndex(Math.max(0, Math.min(results.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          if (selected) useStore.getState().openConversation(selected.item.id)
        }
      }}>
      <div className="thread-search-header">
        <input ref={input} type="text" value={query} placeholder="Search DMs and channels…"
          aria-label="Search DMs and channels" role="combobox" aria-autocomplete="list"
          aria-expanded="true" aria-controls="thread-search-results"
          aria-activedescendant={selected ? `thread-search-${selected.item.id}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0) }} />
        <button className="icon-button" onClick={close} aria-label="Close search" title="Close (Esc)"><CloseIcon /></button>
      </div>
      <ul id="thread-search-results" className="thread-search-results" role="listbox" aria-label="DMs and channels">
        {results.map(({ item, label, user }, resultIndex) => (
          <li key={item.id} id={`thread-search-${item.id}`} role="option" aria-selected={resultIndex === index}
            onMouseMove={() => setSelectedIndex(resultIndex)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => useStore.getState().openConversation(item.id)}>
            <ConversationIcon conversation={item.conversation} label={label} avatar={user?.avatar} />
            <span className="thread-search-label">{label}</span>
            <span className="muted">{item.conversation.kind === 'dm' || item.conversation.kind === 'group' ? 'DM' : 'Channel'}</span>
          </li>
        ))}
      </ul>
      {!results.length && <p className="thread-search-empty" role="status">No matching conversations.</p>}
      <div className="thread-search-footer"><span><kbd>↑</kbd> <kbd>↓</kbd> to select</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>
    </dialog>
  )
}
