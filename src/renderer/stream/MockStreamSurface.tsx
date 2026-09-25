import { useEffect } from "react";
import type { StreamTelemetry } from "../../shared/contracts";
import type { PlaybackSettings } from "./stream-engine";

interface Props {
  reducedMotion: boolean;
  inputSuspended: boolean;
  playbackSettings: PlaybackSettings;
  onConnected: () => void;
  onTelemetry: (telemetry: StreamTelemetry) => void;
}

export function MockStreamSurface({
  reducedMotion,
  inputSuspended,
  playbackSettings,
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
        decodeMs: 4.2,
        jitterBufferMs: 8.4,
        inputQueueBytes: 0,
        frameIntervalP95Ms: 16.7,
        frameIntervalP99Ms: 17.4,
        framesDropped: 0,
        freezeCount: 0,
        freezeDurationMs: 0,
        networkQuality: "excellent",
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
      className="stream-media"
      style={{ containerType: "size", background: "#000" }}
    >
      <div
        className={`mock-stream ${reducedMotion ? "reduced" : ""}`}
        data-testid="mock-stream"
        data-input-suspended={inputSuspended}
        data-video-fit={playbackSettings.videoFit}
        data-volume={playbackSettings.volume}
        data-muted={playbackSettings.muted}
        data-input-polling={playbackSettings.inputPolling}
        style={
          playbackSettings.videoFit === "fit"
            ? {
                width: "min(100cqw, calc(100cqh * 16 / 9))",
                height: "min(100cqh, calc(100cqw * 9 / 16))",
                margin: "auto",
              }
            : undefined
        }
        role="img"
        aria-label="Test remote-play video"
      >
        <div className="mock-sky" />
        <div className="mock-sun" />
        <div className="mock-ridge ridge-back" />
        <div className="mock-ridge ridge-front" />
        <div className="mock-road" />
        <div className="mock-stars" />
      </div>
    </div>
  );
}
