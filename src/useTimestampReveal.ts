import { useEffect, type RefObject } from 'react'

export function useTimestampReveal(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const maximumOffset = 92
    const nativeScrollEnd = 'onscrollend' in element
    element.dataset.timestampScrollEnd = nativeScrollEnd ? 'native' : 'fallback'
    const returnDuration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 480
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    let returning = false
    let pointer: { id: number; x: number; y: number; initial: number; dragging: boolean } | undefined
    let lastDragEnded = -Infinity

    const paint = () => {
      const offset = Math.min(maximumOffset, Math.max(0, element.scrollLeft))
      element.style.setProperty('--timestamp-offset', `${offset}px`)
      element.style.setProperty('--timestamps-visible', String(offset / maximumOffset))
    }
    const stopReturn = () => {
      cancelAnimationFrame(frame)
      returning = false
    }
    const release = () => {
      clearTimeout(releaseTimer)
      if (returning || pointer?.dragging || !element.scrollLeft) return
      if (!returnDuration) { element.scrollLeft = 0; paint(); return }
      const initial = element.scrollLeft
      const start = performance.now()
      returning = true
      const animate = (now: number) => {
        const progress = Math.min(1, (now - start) / returnDuration)
        element.scrollLeft = initial * (1 - progress) ** 3
        paint()
        if (progress < 1) frame = requestAnimationFrame(animate)
        else returning = false
      }
      frame = requestAnimationFrame(animate)
    }
    const scroll = (event: Event) => {
      if (event.target !== element) return
      paint()
      if (!nativeScrollEnd && !returning && !pointer?.dragging) {
        clearTimeout(releaseTimer)
        releaseTimer = setTimeout(release, 700)
      }
    }
    const scrollEnd = (event: Event) => {
      if (event.target === element) release()
    }
    const wheel = (event: WheelEvent) => {
      if (event.deltaX || event.shiftKey) stopReturn()
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('a, button, input, textarea'))) return
      clearTimeout(releaseTimer)
      stopReturn()
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, initial: element.scrollLeft, dragging: false }
    }
    const move = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return
      const dx = pointer.x - event.clientX
      const dy = pointer.y - event.clientY
      if (!pointer.dragging) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
        if (Math.abs(dy) >= Math.abs(dx)) { pointer = undefined; return }
        pointer.dragging = true
        element.setPointerCapture(event.pointerId)
        element.setAttribute('data-timestamps-dragging', '')
      }
      event.preventDefault()
      element.scrollLeft = Math.max(0, Math.min(pointer.initial + dx, maximumOffset))
      paint()
    }
    const up = (event: PointerEvent) => {
      if (!pointer || pointer.id !== event.pointerId) return
      if (pointer.dragging) lastDragEnded = performance.now()
      pointer = undefined
      element.removeAttribute('data-timestamps-dragging')
      release()
    }
    const click = (event: MouseEvent) => {
      if (performance.now() - lastDragEnded < 300) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    paint()
    element.addEventListener('scroll', scroll)
    element.addEventListener('scrollend', scrollEnd)
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    element.addEventListener('click', click, true)
    window.addEventListener('blur', release)
    return () => {
      clearTimeout(releaseTimer)
      cancelAnimationFrame(frame)
      element.removeEventListener('scroll', scroll)
      element.removeEventListener('scrollend', scrollEnd)
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      element.removeEventListener('click', click, true)
      window.removeEventListener('blur', release)
    }
  }, [ref])
}
