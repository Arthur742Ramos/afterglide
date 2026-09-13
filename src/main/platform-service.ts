import type {
  CloudTitle,
  DeviceCode,
  StreamSource,
  XboxConsole,
} from "../shared/contracts";

export interface StreamTarget {
  source: StreamSource;
  id: string;
}

export interface SessionStart {
  sessionId: string;
  sessionPath: string;
}

export interface SessionStateResult {
  state: string;
  errorDetails?: {
    code?: string | number;
    message?: string;
  };
}

export interface ExchangeResult {
  exchangeResponse?: string | null;
}

export interface PlatformService {
  readonly mock: boolean;
  readonly hasStoredAuthentication: boolean;
  readonly cloudAvailable: boolean;
  restore(): Promise<boolean>;
  beginDeviceCode(): Promise<DeviceCode>;
  pollDeviceCode(deviceCode: string, timeoutMs: number): Promise<void>;
  cancelAuthentication(): void;
  signOut(): Promise<void>;
  listConsoles(): Promise<XboxConsole[]>;
  listCloudTitles(): Promise<CloudTitle[]>;
  wakeConsole(consoleId: string): Promise<void>;
  startSession(
    target: StreamTarget,
    resolution: 720 | 1080,
  ): Promise<SessionStart>;
  getSessionState(sessionPath: string): Promise<SessionStateResult>;
  authorizeSession(sessionPath: string): Promise<void>;
  exchangeSdp(
    sessionPath: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<string>;
  exchangeIce(sessionPath: string, candidates: string[]): Promise<string>;
  keepalive(sessionPath: string): Promise<void>;
  stopSession(sessionPath: string): Promise<void>;
}
