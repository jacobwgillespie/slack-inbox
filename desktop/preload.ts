import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('slackDesktop', {
  platform: process.platform,
  openConversation: (channel: string) => ipcRenderer.invoke('slack:conversation-open', channel),
  readConversation: (channel: string, direction?: 'older' | 'latest') => ipcRenderer.invoke('slack:conversation-read', channel, direction),
  onConversationChange: (callback: (channel: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, channel: string) => callback(channel)
    ipcRenderer.on('slack:timeline-changed', listener)
    return () => ipcRenderer.removeListener('slack:timeline-changed', listener)
  },
  readImage: (source: string) => ipcRenderer.invoke('slack:conversation-image', source),
  showSlack: (channel?: string) => ipcRenderer.invoke('slack:show', channel),
  signInWithBrowser: () => ipcRenderer.invoke('slack:signin'),
  hideSlack: () => ipcRenderer.invoke('slack:hide'),
})
