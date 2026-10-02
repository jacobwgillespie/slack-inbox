import { commands } from './commands'
import { channelCollection, dmCollection } from './collections'
import { useConversation } from './data'
import { useEffect, useRef, type RefObject } from 'react'
import { localApi } from './api'
import { compareTs } from './slack/timestamps'
import { inboxStore, useStore } from './store'

export function useReadAtBottom(ref: RefObject<HTMLDivElement | null>, channel: string, latest: string | undefined, atBottom: boolean, enabled: boolean) {
  const selected = useStore((state) => state.selectedId === channel)
  const conversation = useConversation(channel)
  const acknowledged = useRef('0')
  const pending = useRef(false)

  useEffect(() => {
    if (!enabled || !selected || !atBottom || !latest || !conversation) return
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const element = ref.current
        const state = inboxStore.getState()
        const current = channelCollection.get(channel) ?? dmCollection.get(channel)
        if (!element?.clientHeight || !document.hasFocus() || document.hidden || state.selectedId !== channel || !current || pending.current) return
        if (element.scrollHeight - element.scrollTop - element.clientHeight > 8) return
        // A cached older page's bottom is not the end of the conversation.
        if (compareTs(latest, current.latestTs) < 0 || compareTs(latest, current.lastRead ?? '0') <= 0 || compareTs(latest, acknowledged.current) <= 0) return
        pending.current = true
        void localApi.markRead(channel, latest).then(async () => {
          acknowledged.current = latest
          await commands.load()
        }).catch(console.error).finally(() => { pending.current = false })
      }, 350)
    }
    schedule()
    const element = ref.current
    element?.addEventListener('scroll', schedule)
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', schedule)
    return () => {
      clearTimeout(timer)
      element?.removeEventListener('scroll', schedule)
      window.removeEventListener('focus', schedule)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [enabled, selected, atBottom, latest, conversation?.latestTs, conversation?.lastRead, channel, ref])
}
