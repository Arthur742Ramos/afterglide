export type AuthStatus =
  | "restoring"
  | "signed-out"
  | "waiting"
  | "signed-in"
  | "error";

export type ConsolePower = "on" | "standby" | "offline" | "unknown";

export interface XboxConsole {
  id: string;
  name: string;
  model: string;
  power: ConsolePower;
  remotePlayEnabled: boolean;
  remoteManagementEnabled: boolean;
  wirelessWarning: boolean;
  outOfHomeWarning: boolean;
}

export type StreamSource = "home" | "cloud";

export interface CloudTitle {
  id: string;
  productId: string;
  name: string;
  publisher: string;
  imageUrl?: string;
  supportedInputTypes: string[];
  recentlyPlayed: boolean;
}

export interface DeviceCode {
  code: string;
  verificationUrl: string;
  expiresAt: number;
  message: string;
}

export type SessionPhase =
  | "idle"
  | "waking"
  | "provisioning"
  | "authorizing"
  | "negotiating"
  | "streaming"
  | "recovering"
  | "error";

export interface SessionSnapshot {
  phase: SessionPhase;
  label: string;
  detail: string;
  progress: number;
  sessionId?: string;
  consoleId?: string;
  titleId?: string;
  source?: StreamSource;
  targetName?: string;
  errorCode?: string;
  recoverable?: boolean;
}

export interface StreamDescriptor {
  sessionId: string;
  source: StreamSource;
  targetId: string;
  displayName: string;
  consoleId?: string;
  titleId?: string;
  mock: boolean;
}

export interface StreamTelemetry {
  resolution: string;
  framesPerSecond: number;
  roundTripMs: number;
  packetLossPercent: number;
  bitrateMbps: number;
  codec: string;
  connection: "local" | "remote" | "unknown";
  videoDecoder: string;
  networkQuality: "measuring" | "excellent" | "good" | "unstable";
  updatedAt: number;
}

export interface HardwareInfo {
  acceleration: "enabled" | "limited" | "disabled" | "unknown";
  videoDecode: string;
  gpu: string;
  secureStorage: boolean;
  credentialStorage: {
    backend: string;
    detail: string;
  };
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "error";

export interface UpdateSnapshot {
  status: UpdateStatus;
  checkedAt?: number;
  version?: string;
  releaseUrl?: string;
  publishedAt?: string;
  error?: string;
}

export type ControllerRumble = "off" | "low" | "full";
export type ControllerButtonLayout =
  | "standard"
  | "swap-ab"
  | "swap-xy"
  | "swap-both";
export type ControllerDeadzone = 0.04 | 0.08 | 0.12;
export type ControllerTriggerRange = 0.5 | 0.75 | 1;

export interface ControllerTuning {
  rumble: ControllerRumble;
  buttonLayout: ControllerButtonLayout;
  stickDeadzone: ControllerDeadzone;
  triggerRange: ControllerTriggerRange;
}

export interface ControllerProfile extends ControllerTuning {
  id: string;
}

export interface AppSettings {
  resolution: 720 | 1080;
  reducedMotion: boolean;
  showPerformance: boolean;
  keyboardControls: boolean;
  controllerMenuShortcut: "stick-chord" | "steam-input";
  preferredControllerId: string;
  controllerDefaults: ControllerTuning;
  controllerProfiles: ControllerProfile[];
  launchFullscreen: boolean;
  onboardingComplete: boolean;
}

export interface AppSnapshot {
  auth: {
    status: AuthStatus;
    deviceCode?: DeviceCode;
    error?: string;
  };
  consoles: XboxConsole[];
  consolesStatus: "idle" | "loading" | "ready" | "error";
  consolesError?: string;
  selectedConsoleId?: string;
  cloud: {
    available: boolean;
    titles: CloudTitle[];
    status: "idle" | "loading" | "ready" | "unavailable" | "error";
    error?: string;
    selectedTitleId?: string;
  };
  session: SessionSnapshot;
  settings: AppSettings;
  telemetry: StreamTelemetry;
  hardware: HardwareInfo;
  update: UpdateSnapshot;
  environment: "live" | "test";
  version: string;
}

export interface SdpAnswer {
  sdp: string;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export interface StreamApi {
  getSnapshot(): Promise<AppSnapshot>;
  beginSignIn(): Promise<void>;
  cancelSignIn(): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  signOut(): Promise<void>;
  refreshConsoles(): Promise<void>;
  refreshCloudTitles(): Promise<void>;
  selectConsole(consoleId: string): Promise<void>;
  selectCloudTitle(titleId: string): Promise<void>;
  startStream(consoleId: string): Promise<StreamDescriptor>;
  startCloudStream(titleId: string): Promise<StreamDescriptor>;
  retryStream(): Promise<StreamDescriptor>;
  sendSdp(
    sessionId: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<SdpAnswer>;
  sendIce(
    sessionId: string,
    candidates: IceCandidatePayload[],
  ): Promise<IceCandidatePayload[]>;
  keepalive(sessionId: string): Promise<void>;
  reportStreamEvent(
    sessionId: string,
    event: "connected" | "interrupted" | "failed",
    detail?: string,
  ): Promise<void>;
  stopStream(): Promise<void>;
  updateTelemetry(telemetry: StreamTelemetry): Promise<void>;
  updateSettings(settings: Partial<AppSettings>): Promise<void>;
  checkForUpdates(): Promise<void>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  quit(): Promise<void>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
}

export interface TestApi {
  simulateNetworkDrop(): Promise<void>;
  injectGamepad(
    action: "up" | "down" | "left" | "right" | "accept" | "back" | "controls",
  ): Promise<void>;
}

export const defaultControllerTuning: ControllerTuning = {
  rumble: "full",
  buttonLayout: "standard",
  stickDeadzone: 0.08,
  triggerRange: 1,
};

export const defaultSettings: AppSettings = {
  resolution: 1080,
  reducedMotion: false,
  showPerformance: false,
  keyboardControls: false,
  controllerMenuShortcut: "stick-chord",
  preferredControllerId: "",
  controllerDefaults: { ...defaultControllerTuning },
  controllerProfiles: [],
  launchFullscreen: false,
  onboardingComplete: false,
};

export const emptyTelemetry: StreamTelemetry = {
  resolution: "Waiting for video",
  framesPerSecond: 0,
  roundTripMs: 0,
  packetLossPercent: 0,
  bitrateMbps: 0,
  codec: "Waiting",
  connection: "unknown",
  videoDecoder: "Chromium automatic",
  networkQuality: "measuring",
  updatedAt: 0,
};

export const idleSession = (): SessionSnapshot => ({
  phase: "idle",
  label: "Ready to play",
  detail: "Choose a console to begin.",
  progress: 0,
});

export const IPC = {
  snapshot: "afterglide:snapshot",
  getSnapshot: "afterglide:get-snapshot",
  beginSignIn: "afterglide:begin-sign-in",
  cancelSignIn: "afterglide:cancel-sign-in",
  openExternal: "afterglide:open-external",
  copyText: "afterglide:copy-text",
  signOut: "afterglide:sign-out",
  refreshConsoles: "afterglide:refresh-consoles",
  refreshCloudTitles: "afterglide:refresh-cloud-titles",
  selectConsole: "afterglide:select-console",
  selectCloudTitle: "afterglide:select-cloud-title",
  startStream: "afterglide:start-stream",
  startCloudStream: "afterglide:start-cloud-stream",
  retryStream: "afterglide:retry-stream",
  sendSdp: "afterglide:send-sdp",
  sendIce: "afterglide:send-ice",
  keepalive: "afterglide:keepalive",
  reportStreamEvent: "afterglide:report-stream-event",
  stopStream: "afterglide:stop-stream",
  updateTelemetry: "afterglide:update-telemetry",
  updateSettings: "afterglide:update-settings",
  checkForUpdates: "afterglide:check-for-updates",
  setFullscreen: "afterglide:set-fullscreen",
  quit: "afterglide:quit",
  testNetworkDrop: "afterglide:test-network-drop",
  testGamepad: "afterglide:test-gamepad",
} as const;
