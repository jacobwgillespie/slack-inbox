import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('slackDesktop', {
  platform: process.platform,
  openConversation: (channel: string) => ipcRenderer.invoke('slack:conversation-open', channel),
  readConversation: (channel: string, direction?: 'older' | 'latest') => ipcRenderer.invoke('slack:conversation-read', channel, direction),
  readImage: (source: string) => ipcRenderer.invoke('slack:conversation-image', source),
  showSlack: (channel?: string) => ipcRenderer.invoke('slack:show', channel),
  signInWithBrowser: () => ipcRenderer.invoke('slack:signin'),
  hideSlack: () => ipcRenderer.invoke('slack:hide'),
})
