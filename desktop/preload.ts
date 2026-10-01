import type { ComposerAction, ComposerSnapshot } from '../src/slack/composer'
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('slackDesktop', {
  platform: process.platform,
  followComposer: (channel: string) => ipcRenderer.invoke('slack:composer-follow', channel),
  stopComposer: (generation: number) => ipcRenderer.invoke('slack:composer-stop', generation),
  composerAction: (generation: number, action: ComposerAction) => ipcRenderer.invoke('slack:composer-action', generation, action),
  onComposerChange: (callback: (draft: ComposerSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, draft: ComposerSnapshot) => callback(draft)
    ipcRenderer.on('slack:composer-changed', listener)
    return () => ipcRenderer.removeListener('slack:composer-changed', listener)
  },
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
