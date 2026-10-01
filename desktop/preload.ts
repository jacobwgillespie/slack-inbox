import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('slackDesktop', {
  platform: process.platform,
  readCache: (channel?: string, options?: { before?: string; after?: string }) => ipcRenderer.invoke('slack:cache-read', channel, options),
  watchConversations: (channels: string[], selected?: string) => ipcRenderer.invoke('slack:cache-watch', channels, selected),
  refreshConversation: (channel: string, older = false) => ipcRenderer.invoke('slack:cache-refresh', channel, older),
  onCacheChange: (callback: (channel?: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, channel?: string) => callback(channel)
    ipcRenderer.on('slack:cache-changed', listener)
    return () => ipcRenderer.removeListener('slack:cache-changed', listener)
  },
  readImage: (source: string) => ipcRenderer.invoke('slack:conversation-image', source),
  showSlack: (channel?: string) => ipcRenderer.invoke('slack:show', channel),
  signInWithBrowser: () => ipcRenderer.invoke('slack:signin'),
  logOut: () => ipcRenderer.invoke('slack:logout'),
  hideSlack: () => ipcRenderer.invoke('slack:hide'),
})
