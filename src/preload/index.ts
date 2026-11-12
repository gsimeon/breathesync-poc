import { contextBridge, ipcRenderer } from 'electron';

type Listener<T> = (payload: T) => void;

function subscribe<T>(channel: string, listener: Listener<T>) {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('breatheSync', {
  getCameras: () => ipcRenderer.invoke('breathesync:cameras'),
  getState: () => ipcRenderer.invoke('breathesync:state'),
  start: (cameraId: string) => ipcRenderer.invoke('breathesync:start', cameraId),
  stop: () => ipcRenderer.invoke('breathesync:stop'),
  onMetrics: (listener: Listener<unknown>) => subscribe('breathesync:metrics', listener),
  onStatus: (listener: Listener<unknown>) => subscribe('breathesync:status', listener),
  onError: (listener: Listener<unknown>) => subscribe('breathesync:error', listener),
  onSessionState: (listener: Listener<unknown>) => subscribe('breathesync:session-state', listener),
});
