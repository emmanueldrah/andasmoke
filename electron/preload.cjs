const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer talks to the local server over fetch('/api/...'), so it needs no
 * Node access. Only printer support crosses the bridge, because Electron's
 * print API is not reachable from a sandboxed renderer.
 */
contextBridge.exposeInMainWorld('andaPos', {
  print: () => ipcRenderer.invoke('pos:print'),
  onUpdateDownloaded: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('pos:update-downloaded', handler);
    return () => ipcRenderer.removeListener('pos:update-downloaded', handler);
  },
  restartAndInstallUpdate: () => ipcRenderer.invoke('pos:restart-and-install'),
});