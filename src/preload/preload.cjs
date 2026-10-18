'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const role = process.argv.includes('--slate-role=ball') ? 'ball' : 'main';
const invoke = channel => () => ipcRenderer.invoke(channel);
const sync = (channel, value) => {
  const reply = ipcRenderer.sendSync(channel, value);
  if (!reply || reply.ok !== true) throw Error(reply?.error || '无法读取便携数据。');
  return reply.value;
};
contextBridge.exposeInMainWorld('slateDesktop', Object.freeze({
  role, state: invoke('slate:state'), updateSettings: patch => ipcRenderer.invoke('slate:settings', patch),
  openMain: options => ipcRenderer.invoke('slate:open-main', options), hideMain: invoke('slate:hide-main'), quit: invoke('slate:quit'),
  beginQuitConfirmation: invoke('slate:quit-confirmation-open'), endQuitConfirmation: invoke('slate:quit-confirmation-close'),
  data: Object.freeze({
    preview: process.argv.includes('--slate-preview'),
    loadClass: () => sync('slate:data-load'), saveClass: state => sync('slate:data-save', state),
    info: invoke('slate:data-info'),
    readCredentials: scope => ipcRenderer.invoke('slate:data-credentials-read', scope),
    writeCredentials: (scope, payload) => ipcRenderer.invoke('slate:data-credentials-write', scope, payload),
    restoreAll: payload => ipcRenderer.invoke('slate:data-restore', payload),
    saveFile: file => ipcRenderer.invoke('slate:data-file-save', file)
  }),
  speech: Object.freeze({ synthesize: (text, voice) => ipcRenderer.invoke('slate:speech-synthesize', { text, voice }), clearCache: invoke('slate:speech-cache-clear'), cancelPending: invoke('slate:speech-cancel') }),
  dragStart: start => ipcRenderer.invoke('slate:drag-start', start), dragMove: position => ipcRenderer.send('slate:drag-move', position),
  dragEnd: end => ipcRenderer.invoke('slate:drag-end', end),
  beginConfirmation: invoke('slate:confirmation-open'), endConfirmation: invoke('slate:confirmation-close'),
  subscribe(callback) {
    if (typeof callback !== 'function') throw TypeError('A state callback is required.');
    const listener = (_event, state) => callback(state); ipcRenderer.on('slate:state-changed', listener);
    return () => ipcRenderer.removeListener('slate:state-changed', listener);
  },
  onImportRequest(callback) {
    if (typeof callback !== 'function') throw TypeError('A backup callback is required.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('slate:import-request', listener);
    return () => ipcRenderer.removeListener('slate:import-request', listener);
  }
}));
