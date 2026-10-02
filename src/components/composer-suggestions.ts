import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'

export interface ComposerSuggestion {
  id: string
  label: string
  detail?: string
  image?: string
  glyph?: string
}

/** Shared keyboard navigation for composer suggestions. */
export function suggestionMenu(onOpen: (open: boolean) => void): SuggestionOptions<ComposerSuggestion>['render'] {
  return () => {
    let panel: HTMLDivElement | undefined
    let props: SuggestionProps<ComposerSuggestion>
    let selected = 0
    const draw = () => {
      if (!panel) return
      panel.replaceChildren()
      for (const [index, item] of props.items.entries()) {
        const button = document.createElement('button')
        button.type = 'button'
        button.role = 'option'
        button.setAttribute('aria-selected', String(index === selected))
        button.addEventListener('mousedown', (event) => event.preventDefault())
        button.addEventListener('click', () => props.command(item))
        if (item.image) {
          const image = document.createElement('img')
          image.src = item.image
          image.alt = ''
          button.append(image)
        } else if (item.glyph) {
          const glyph = document.createElement('span')
          glyph.className = 'suggestion-glyph'
          glyph.textContent = item.glyph
          button.append(glyph)
        }
        const label = document.createElement('span')
        label.textContent = item.label
        button.append(label)
        if (item.detail) {
          const detail = document.createElement('small')
          detail.textContent = item.detail
          button.append(detail)
        }
        panel.append(button)
      }
      if (!props.items.length) panel.textContent = 'No matches'
      const rect = props.clientRect?.()
      if (rect) {
        panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`
        panel.style.top = `${Math.max(8, rect.top - panel.offsetHeight - 8)}px`
      }
      panel.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    }
    return {
      onStart(next) {
        props = next
        selected = 0
        panel = document.createElement('div')
        panel.className = 'composer-suggestions'
        panel.role = 'listbox'
        panel.setAttribute('aria-label', 'Suggestions')
        document.body.append(panel)
        onOpen(true)
        draw()
      },
      onUpdate(next) { props = next; selected = 0; draw() },
      onKeyDown({ event }) {
        if (event.isComposing) return false
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + props.items.length) % (props.items.length || 1)
          draw()
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = props.items[selected]
          if (item) props.command(item)
          return true
        }
        return false
      },
      onExit() { panel?.remove(); panel = undefined; onOpen(false) },
    }
  }
}
