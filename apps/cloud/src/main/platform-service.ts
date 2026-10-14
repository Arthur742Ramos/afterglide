import type {
  CloudTitle,
  DeviceCode,
  StreamSource,
  RegionSelection,
} from "../shared/contracts";
import type { OperationContext } from "./operation-context";

export interface StreamTarget {
  source: StreamSource;
  id: string;
}

export interface SessionStart {
  regionSelection?: RegionSelection;
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
  listCloudTitles(
    onProgress?: (titles: CloudTitle[]) => void,
    operation?: OperationContext,
  ): Promise<CloudTitle[]>;
  searchCloudTitles?(
    query: string,
    operation?: OperationContext,
  ): Promise<CloudTitle[]>;
  startSession(
    target: StreamTarget,
    resolution: 720 | 1080,
    operation?: OperationContext,
  ): Promise<SessionStart>;
  getSessionState(
    sessionPath: string,
    operation?: OperationContext,
  ): Promise<SessionStateResult>;
  authorizeSession(
    sessionPath: string,
    operation?: OperationContext,
  ): Promise<void>;
  exchangeSdp(
    sessionPath: string,
    offer: RTCSessionDescriptionInit,
  ): Promise<string>;
  exchangeIce(sessionPath: string, candidates: string[]): Promise<string>;
  keepalive(sessionPath: string): Promise<void>;
  stopSession(sessionPath: string, sessionId?: string): Promise<void>;
}
