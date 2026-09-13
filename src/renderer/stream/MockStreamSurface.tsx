import { useEffect } from "react";
import type { StreamTelemetry } from "../../shared/contracts";

interface Props {
  reducedMotion: boolean;
  onConnected: () => void;
  onTelemetry: (telemetry: StreamTelemetry) => void;
}

export function MockStreamSurface({
  reducedMotion,
  onConnected,
  onTelemetry,
}: Props) {
  useEffect(() => {
    const connected = window.setTimeout(onConnected, 260);
    const publish = () =>
      onTelemetry({
        resolution: "1920 × 1080",
        framesPerSecond: 60,
        roundTripMs: 23,
        packetLossPercent: 0.08,
        bitrateMbps: 14.7,
        codec: "H264 High",
        connection: "local",
        videoDecoder: "E2E deterministic surface",
        updatedAt: Date.now(),
      });
    publish();
    const telemetry = window.setInterval(publish, 1_000);
    return () => {
      clearTimeout(connected);
      clearInterval(telemetry);
    };
  }, [onConnected, onTelemetry]);

  return (
    <div
      className={`mock-stream ${reducedMotion ? "reduced" : ""}`}
      data-testid="mock-stream"
      aria-label="Test remote-play video"
    >
      <div className="mock-sky" />
      <div className="mock-sun" />
      <div className="mock-ridge ridge-back" />
      <div className="mock-ridge ridge-front" />
      <div className="mock-road" />
      <div className="mock-stars" />
    </div>
  );
}
