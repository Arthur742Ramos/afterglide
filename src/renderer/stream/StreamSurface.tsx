import { useCallback, useEffect, useRef } from "react";
import type { StreamDescriptor, StreamTelemetry } from "../../shared/contracts";
import { MockStreamSurface } from "./MockStreamSurface";
import { XboxStreamEngine } from "./stream-engine";

interface Props {
  descriptor: StreamDescriptor;
  reducedMotion: boolean;
  keyboardControls: boolean;
  onConnected: () => void;
  onInterrupted: () => void;
  onError: (message: string) => void;
  onTelemetry: (telemetry: StreamTelemetry) => void;
}

export function StreamSurface(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const onConnected = useCallback(props.onConnected, [props.onConnected]);
  const onInterrupted = useCallback(props.onInterrupted, [props.onInterrupted]);
  const onError = useCallback(props.onError, [props.onError]);
  const onTelemetry = useCallback(props.onTelemetry, [props.onTelemetry]);

  useEffect(() => {
    if (props.descriptor.mock || !container.current) return;
    const engine = new XboxStreamEngine({
      sessionId: props.descriptor.sessionId,
      container: container.current,
      keyboardControls: props.keyboardControls,
      onConnected,
      onInterrupted,
      onError,
      onTelemetry,
    });
    void engine.connect();
    return () => engine.destroy();
  }, [
    props.descriptor,
    props.keyboardControls,
    onConnected,
    onInterrupted,
    onError,
    onTelemetry,
  ]);

  if (props.descriptor.mock) {
    return (
      <MockStreamSurface
        reducedMotion={props.reducedMotion}
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
