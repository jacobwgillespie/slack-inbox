import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('slackDesktop', {
  platform: process.platform,
  setInboxCount: (count: number) => ipcRenderer.invoke('slack:inbox-count', count),
  reportActivity: () => ipcRenderer.invoke('slack:activity'),
  onSelfPresence: (callback: (presence: 'active' | 'away') => void) => {
    const listener = (_event: Electron.IpcRendererEvent, presence: 'active' | 'away') => callback(presence)
    ipcRenderer.on('slack:self-presence', listener)
    return () => ipcRenderer.removeListener('slack:self-presence', listener)
  },
  updateVersion: () => ipcRenderer.invoke('slack:update-version'),
  installUpdate: () => ipcRenderer.invoke('slack:update-install'),
  onUpdateReady: (callback: (version: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, version: string) => callback(version)
    ipcRenderer.on('slack:update-ready', listener)
    return () => ipcRenderer.removeListener('slack:update-ready', listener)
  },
  sendTyping: (channel: string) => ipcRenderer.invoke('slack:typing', channel),
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
  signInWithBrowser: (restart?: boolean) => ipcRenderer.invoke('slack:signin', restart),
  logOut: () => ipcRenderer.invoke('slack:logout'),
  hideSlack: () => ipcRenderer.invoke('slack:hide'),
})
