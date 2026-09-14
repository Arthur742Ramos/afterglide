import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  AppSnapshot,
  IceCandidatePayload,
  StreamApi,
  StreamTelemetry,
  TestApi,
} from "../shared/contracts";
import { IPC } from "../shared/contracts";

const api: StreamApi = {
  getSnapshot: () =>
    ipcRenderer.invoke(IPC.getSnapshot) as Promise<AppSnapshot>,
  beginSignIn: () => ipcRenderer.invoke(IPC.beginSignIn) as Promise<void>,
  cancelSignIn: () => ipcRenderer.invoke(IPC.cancelSignIn) as Promise<void>,
  openExternal: (url) =>
    ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text) as Promise<void>,
  signOut: () => ipcRenderer.invoke(IPC.signOut) as Promise<void>,
  refreshConsoles: () =>
    ipcRenderer.invoke(IPC.refreshConsoles) as Promise<void>,
  refreshCloudTitles: () =>
    ipcRenderer.invoke(IPC.refreshCloudTitles) as Promise<void>,
  selectConsole: (consoleId) =>
    ipcRenderer.invoke(IPC.selectConsole, consoleId) as Promise<void>,
  selectCloudTitle: (titleId) =>
    ipcRenderer.invoke(IPC.selectCloudTitle, titleId) as Promise<void>,
  startStream: (consoleId) => ipcRenderer.invoke(IPC.startStream, consoleId),
  startCloudStream: (titleId) =>
    ipcRenderer.invoke(IPC.startCloudStream, titleId),
  retryStream: () => ipcRenderer.invoke(IPC.retryStream),
  sendSdp: (sessionId, offer) =>
    ipcRenderer.invoke(IPC.sendSdp, sessionId, offer),
  sendIce: (sessionId, candidates: IceCandidatePayload[]) =>
    ipcRenderer.invoke(IPC.sendIce, sessionId, candidates),
  keepalive: (sessionId) =>
    ipcRenderer.invoke(IPC.keepalive, sessionId) as Promise<void>,
  reportStreamEvent: (sessionId, event, detail) =>
    ipcRenderer.invoke(
      IPC.reportStreamEvent,
      sessionId,
      event,
      detail,
    ) as Promise<void>,
  stopStream: () => ipcRenderer.invoke(IPC.stopStream) as Promise<void>,
  updateTelemetry: (telemetry: StreamTelemetry) =>
    ipcRenderer.invoke(IPC.updateTelemetry, telemetry) as Promise<void>,
  updateSettings: (settings: Partial<AppSettings>) =>
    ipcRenderer.invoke(IPC.updateSettings, settings) as Promise<void>,
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC.checkForUpdates) as Promise<void>,
  exportPerformanceReport: () =>
    ipcRenderer.invoke(IPC.exportPerformanceReport) as Promise<boolean>,
  setFullscreen: (fullscreen) =>
    ipcRenderer.invoke(IPC.setFullscreen, fullscreen) as Promise<void>,
  quit: () => ipcRenderer.invoke(IPC.quit) as Promise<void>,
  onSnapshot: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: AppSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(IPC.snapshot, handler);
    return () => ipcRenderer.removeListener(IPC.snapshot, handler);
  },
};

contextBridge.exposeInMainWorld("afterglide", api);

if (process.env.AFTERGLIDE_E2E === "1") {
  const testApi: TestApi = {
    simulateNetworkDrop: () =>
      ipcRenderer.invoke(IPC.testNetworkDrop) as Promise<void>,
    injectGamepad: (action) =>
      ipcRenderer.invoke(IPC.testGamepad, action) as Promise<void>,
  };
  ipcRenderer.on(`${IPC.testGamepad}:event`, (_event, action: string) => {
    window.dispatchEvent(
      new CustomEvent("afterglide-gamepad", { detail: action }),
    );
  });
  contextBridge.exposeInMainWorld("afterglideTest", testApi);
}
