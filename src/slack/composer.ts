export interface ComposerSelection {
  anchor: number[]
  anchorOffset: number
  focus: number[]
  focusOffset: number
}

export interface ComposerSnapshot {
  channel: string
  generation: number
  html: string
  action?: ComposerAction['type']
  selection?: ComposerSelection
  source: 'slack' | 'inbox'
}

export type ComposerAction =
  | { type: 'input'; html: string; selection?: ComposerSelection }
  | { type: 'key'; key: string; selection?: ComposerSelection }
  | { type: 'click'; id: string; selection?: ComposerSelection }

export function readComposerSelection(editor: HTMLElement): ComposerSelection | undefined {
  const selection = window.getSelection()
  if (!selection?.anchorNode || !selection.focusNode || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return
  const path = (node: Node) => {
    const result: number[] = []
    while (node !== editor && node.parentNode) {
      result.unshift([...node.parentNode.childNodes].indexOf(node as ChildNode))
      node = node.parentNode
    }
    return result
  }
  return { anchor: path(selection.anchorNode), anchorOffset: selection.anchorOffset, focus: path(selection.focusNode), focusOffset: selection.focusOffset }
}

export function restoreComposerSelection(editor: HTMLElement, selection?: ComposerSelection) {
  if (!selection) return
  const nodeAt = (path: number[]) => path.reduce<Node | undefined>((node, index) => node?.childNodes[index], editor)
  const anchor = nodeAt(selection.anchor), focus = nodeAt(selection.focus)
  if (!anchor || !focus) return
  const length = (node: Node) => node.nodeType === Node.TEXT_NODE ? node.textContent?.length ?? 0 : node.childNodes.length
  window.getSelection()?.setBaseAndExtent(anchor, Math.min(selection.anchorOffset, length(anchor)), focus, Math.min(selection.focusOffset, length(focus)))
}
