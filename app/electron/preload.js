const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chiefman', {
  init: () => ipcRenderer.invoke('cm:init'),
  watch: (paneId) => ipcRenderer.send('cm:watch', paneId),
  term: (paneId) => ipcRenderer.send('cm:term', paneId),
  termInput: (paneId, data) => ipcRenderer.send('cm:term-input', paneId, data),
  send: (paneId, text, replace) => ipcRenderer.invoke('cm:send', paneId, text, replace === true),
  sendChief: (text, replace) => ipcRenderer.invoke('cm:chief-send', text, replace === true),
  cycleMode: (paneId) => ipcRenderer.invoke('cm:mode', paneId),
  mask: (text) => ipcRenderer.invoke('cm:mask', text),
  newBox: (spec) => ipcRenderer.invoke('cm:new-box', spec),
  interrupt: (paneId) => ipcRenderer.invoke('cm:interrupt', paneId),
  choose: (paneId, n, ask) => ipcRenderer.invoke('cm:choose', paneId, n, ask),
  dismiss: (paneId) => ipcRenderer.invoke('cm:dismiss', paneId),
  answer: (paneId, text, ask) => ipcRenderer.invoke('cm:answer', paneId, text, ask),
  submitMenu: (paneId, picks, text, ask) => ipcRenderer.invoke('cm:submit-menu', paneId, picks, text, ask),
  action: (paneId, kind) => ipcRenderer.invoke('cm:action', paneId, kind),
  rename: (paneId, name) => ipcRenderer.invoke('cm:rename', paneId, name),
  recent: () => ipcRenderer.invoke('cm:recent'),
  switchBox: (paneId, kind, value) => ipcRenderer.invoke('cm:switch', paneId, kind, value),
  remote: (paneId, what) => ipcRenderer.invoke('cm:remote', paneId, what),
  copy: (text) => ipcRenderer.send('cm:copy', text),
  attach: (name, data) => ipcRenderer.invoke('cm:attach', name, data),
  retry: (paneId) => ipcRenderer.invoke('cm:retry', paneId),
  startAgain: (name, message) => ipcRenderer.invoke('cm:start-again', name, message),
  closeEnded: (name) => ipcRenderer.invoke('cm:close-ended', name),
  closeBox: (paneId) => ipcRenderer.invoke('cm:close-box', paneId),
  rewind: (paneId, spec) => ipcRenderer.invoke('cm:rewind', paneId, spec),
  files: (paneId, query) => ipcRenderer.invoke('cm:files', paneId, query),
  steps: (paneId, ids) => ipcRenderer.invoke('cm:steps', paneId, ids),
  drafts: () => ipcRenderer.invoke('cm:drafts'),
  saveDrafts: (d) => ipcRenderer.send('cm:drafts-save', d),
  openUrl: (url) => ipcRenderer.send('cm:open-url', url),
  onEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('cm:event', h);
    return () => ipcRenderer.removeListener('cm:event', h);
  },
});
