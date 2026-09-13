import { useCallback, useEffect, useRef } from "react";
import type {
  AppSettings,
  StreamDescriptor,
  StreamTelemetry,
} from "../../shared/contracts";
import { MockStreamSurface } from "./MockStreamSurface";
import { XboxStreamEngine, type ControllerStatus } from "./stream-engine";

interface Props {
  descriptor: StreamDescriptor;
  reducedMotion: boolean;
  keyboardControls: boolean;
  reserveControlChord: boolean;
  controllerSettings: Pick<
    AppSettings,
    "preferredControllerId" | "controllerDefaults" | "controllerProfiles"
  >;
  inputSuspended: boolean;
  onConnected: () => void;
  onInterrupted: () => void;
  onError: (message: string) => void;
  onTelemetry: (telemetry: StreamTelemetry) => void;
  onControllerStatus: (status: ControllerStatus) => void;
}

export function StreamSurface(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const engine = useRef<XboxStreamEngine | undefined>(undefined);
  const onConnected = useCallback(props.onConnected, [props.onConnected]);
  const onInterrupted = useCallback(props.onInterrupted, [props.onInterrupted]);
  const onError = useCallback(props.onError, [props.onError]);
  const onTelemetry = useCallback(props.onTelemetry, [props.onTelemetry]);
  const onControllerStatus = useCallback(props.onControllerStatus, [
    props.onControllerStatus,
  ]);

  useEffect(() => {
    if (props.descriptor.mock || !container.current) return;
    const streamEngine = new XboxStreamEngine({
      sessionId: props.descriptor.sessionId,
      container: container.current,
      keyboardControls: props.keyboardControls,
      reserveControlChord: props.reserveControlChord,
      controllerSettings: props.controllerSettings,
      onConnected,
      onInterrupted,
      onError,
      onTelemetry,
      onControllerStatus,
    });
    engine.current = streamEngine;
    void streamEngine.connect();
    return () => {
      engine.current = undefined;
      streamEngine.destroy();
    };
  }, [
    props.descriptor,
    props.keyboardControls,
    props.reserveControlChord,
    onConnected,
    onInterrupted,
    onError,
    onTelemetry,
    onControllerStatus,
  ]);

  useEffect(() => {
    engine.current?.setInputSuspended(props.inputSuspended);
  }, [props.inputSuspended]);

  if (props.descriptor.mock) {
    return (
      <MockStreamSurface
        reducedMotion={props.reducedMotion}
        inputSuspended={props.inputSuspended}
        onConnected={onConnected}
        onTelemetry={onTelemetry}
      />
    );
  }
  return (
    <div
      ref={container}
      className="stream-media"
      data-testid="stream-media"
      role="img"
      aria-label={`${props.descriptor.displayName} remote-play video`}
    />
  );
}
