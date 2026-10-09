import { useCallback, useEffect, useRef } from "react";
import type {
  AppSettings,
  StreamDescriptor,
  StreamTelemetry,
} from "../../shared/contracts";
import { MockStreamSurface } from "./MockStreamSurface";
import {
  XboxStreamEngine,
  type ControllerStatus,
  type PlaybackSettings,
} from "./stream-engine";

interface Props {
  descriptor: StreamDescriptor;
  reducedMotion: boolean;
  keyboardControls: boolean;
  reserveControlChord: boolean;
  playbackSettings: PlaybackSettings;
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
  onControlsShortcut: () => void;
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
  const onControlsShortcut = useCallback(props.onControlsShortcut, [
    props.onControlsShortcut,
  ]);

  useEffect(() => {
    if (props.descriptor.mock || !container.current) return;
    const streamEngine = new XboxStreamEngine({
      sessionId: props.descriptor.sessionId,
      container: container.current,
      keyboardControls: props.keyboardControls,
      reserveControlChord: props.reserveControlChord,
      controllerSettings: props.controllerSettings,
      playbackSettings: props.playbackSettings,
      onConnected,
      onInterrupted,
      onError,
      onTelemetry,
      onControllerStatus,
      onControlsShortcut,
    });
    engine.current = streamEngine;
    streamEngine.setInputSuspended(props.inputSuspended);
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
    onControlsShortcut,
  ]);

  useEffect(() => {
    engine.current?.setInputSuspended(props.inputSuspended);
  }, [props.inputSuspended, props.descriptor]);

  useEffect(() => {
    engine.current?.setPlaybackSettings(props.playbackSettings);
  }, [props.playbackSettings, props.descriptor]);

  useEffect(() => {
    engine.current?.setControllerSettings(props.controllerSettings);
  }, [props.controllerSettings, props.descriptor]);

  if (props.descriptor.mock) {
    return (
      <MockStreamSurface
        reducedMotion={props.reducedMotion}
        inputSuspended={props.inputSuspended}
        playbackSettings={props.playbackSettings}
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
