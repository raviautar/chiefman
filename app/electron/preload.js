const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chiefman', {
  init: () => ipcRenderer.invoke('cm:init'),
  watch: (paneId) => ipcRenderer.send('cm:watch', paneId),
  term: (paneId) => ipcRenderer.send('cm:term', paneId),
  termInput: (paneId, data) => ipcRenderer.send('cm:term-input', paneId, data),
  send: (paneId, text) => ipcRenderer.invoke('cm:send', paneId, text),
  sendChief: (text) => ipcRenderer.invoke('cm:chief-send', text),
  newBox: (spec) => ipcRenderer.invoke('cm:new-box', spec),
  interrupt: (paneId) => ipcRenderer.invoke('cm:interrupt', paneId),
  choose: (paneId, n) => ipcRenderer.invoke('cm:choose', paneId, n),
  action: (paneId, kind) => ipcRenderer.invoke('cm:action', paneId, kind),
  rename: (paneId, name) => ipcRenderer.invoke('cm:rename', paneId, name),
  recent: () => ipcRenderer.invoke('cm:recent'),
  switchBox: (paneId, kind, value) => ipcRenderer.invoke('cm:switch', paneId, kind, value),
  remote: (paneId) => ipcRenderer.invoke('cm:remote', paneId),
  copy: (text) => ipcRenderer.send('cm:copy', text),
  attach: (name, data) => ipcRenderer.invoke('cm:attach', name, data),
  openUrl: (url) => ipcRenderer.send('cm:open-url', url),
  onEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('cm:event', h);
    return () => ipcRenderer.removeListener('cm:event', h);
  },
});
