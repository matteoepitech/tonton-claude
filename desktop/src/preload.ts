// The island page's only way out of its sandbox: a few calls to the main process, no Node, no Electron object.

import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, type IslandBridge, type IslandCommand } from './bridge'

const bridge: IslandBridge = {
  account: () => ipcRenderer.invoke(CHANNELS.account),
  canRemember: () => ipcRenderer.invoke(CHANNELS.canRemember),
  signIn: (recoveryKey, remember) => ipcRenderer.invoke(CHANNELS.signIn, recoveryKey, remember),
  createAccount: (relay, remember) => ipcRenderer.invoke(CHANNELS.createAccount, relay, remember),
  signOut: () => ipcRenderer.invoke(CHANNELS.signOut),
  setMode: mode => ipcRenderer.send(CHANNELS.mode, mode),
  showMenu: () => ipcRenderer.send(CHANNELS.menu),
  onCommand: listener => {
    ipcRenderer.on(CHANNELS.command, (_event, command: IslandCommand) => listener(command))
  },
}

contextBridge.exposeInMainWorld('tonton', bridge)
