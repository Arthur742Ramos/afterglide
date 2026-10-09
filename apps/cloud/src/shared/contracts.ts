export type AuthStatus =
  | "restoring"
  | "signed-out"
  | "waiting"
  | "signed-in"
  | "error";

export type StreamSource = "cloud";

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
  decodeMs?: number;
  jitterBufferMs?: number;
  inputQueueBytes?: number;
  frameIntervalP95Ms?: number;
  frameIntervalP99Ms?: number;
  framesDropped?: number;
  freezeCount?: number;
  freezeDurationMs?: number;
  recoveryMs?: number;
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
  volume: number;
  muted: boolean;
  videoFit: "fit" | "fill";
  inputPolling: "responsive" | "efficient";
}

export interface AppSnapshot {
  auth: {
    status: AuthStatus;
    deviceCode?: DeviceCode;
    error?: string;
  };
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
  fullscreen: boolean;
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

export type DesktopCommand = "search" | "settings" | "controls";

export interface StreamApi {
  getSnapshot(): Promise<AppSnapshot>;
  beginSignIn(): Promise<void>;
  cancelSignIn(): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  signOut(): Promise<void>;
  refreshCloudTitles(): Promise<void>;
  selectCloudTitle(titleId: string): Promise<void>;
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
  updateTelemetry(telemetry: StreamTelemetry): void;
  updateSettings(settings: Partial<AppSettings>): Promise<void>;
  checkForUpdates(): Promise<void>;
  exportPerformanceReport(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  quit(): Promise<void>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  onDesktopCommand(listener: (command: DesktopCommand) => void): () => void;
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
  volume: 1,
  muted: false,
  videoFit: "fit",
  inputPolling: "responsive",
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
  detail: "Choose a cloud game to begin.",
  progress: 0,
});

export const IPC = {
  desktopCommand: "afterglide-cloud:desktop-command",
  snapshot: "afterglide-cloud:snapshot",
  getSnapshot: "afterglide-cloud:get-snapshot",
  beginSignIn: "afterglide-cloud:begin-sign-in",
  cancelSignIn: "afterglide-cloud:cancel-sign-in",
  openExternal: "afterglide-cloud:open-external",
  copyText: "afterglide-cloud:copy-text",
  signOut: "afterglide-cloud:sign-out",
  refreshCloudTitles: "afterglide-cloud:refresh-cloud-titles",
  selectCloudTitle: "afterglide-cloud:select-cloud-title",
  startCloudStream: "afterglide-cloud:start-cloud-stream",
  retryStream: "afterglide-cloud:retry-stream",
  sendSdp: "afterglide-cloud:send-sdp",
  sendIce: "afterglide-cloud:send-ice",
  keepalive: "afterglide-cloud:keepalive",
  reportStreamEvent: "afterglide-cloud:report-stream-event",
  stopStream: "afterglide-cloud:stop-stream",
  updateTelemetry: "afterglide-cloud:update-telemetry",
  updateSettings: "afterglide-cloud:update-settings",
  checkForUpdates: "afterglide-cloud:check-for-updates",
  exportPerformanceReport: "afterglide-cloud:export-performance-report",
  setFullscreen: "afterglide-cloud:set-fullscreen",
  quit: "afterglide-cloud:quit",
  testNetworkDrop: "afterglide-cloud:test-network-drop",
  testGamepad: "afterglide-cloud:test-gamepad",
} as const;
