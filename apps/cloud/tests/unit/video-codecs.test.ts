import { describe, expect, it } from "vitest";
import { preferredVideoCodecs } from "../../src/renderer/stream/video-codecs";

const codec = (name: string, fmtp?: string): RTCRtpCodec => ({
  mimeType: `video/${name}`,
  clockRate: 90_000,
  ...(fmtp ? { sdpFmtpLine: fmtp } : {}),
});

describe("video loss-repair negotiation", () => {
  it("retains every repair codec and fallback while preferring supported H264 profiles", () => {
    const capabilities = [
      codec("VP8"),
      codec("rtx", "apt=96"),
      codec("H264", "profile-level-id=42e01f"),
      codec("rtx", "apt=102"),
      codec("red"),
      codec("ulpfec"),
      codec("AV1"),
      codec("H264", "profile-level-id=4D001F"),
      codec("H264", "profile-level-id=64001f"),
      codec("H264", "profile-level-id=42001f"),
      codec("flexfec-03"),
      codec("VP9"),
    ];
    const before = [...capabilities];
    const preferred = preferredVideoCodecs(capabilities);
    expect(preferred).toEqual([
      capabilities[7],
      capabilities[2],
      capabilities[9],
      capabilities[8],
      ...capabilities.filter((value) => value.mimeType !== "video/H264"),
    ]);
    expect(preferred).toHaveLength(capabilities.length);
    expect(capabilities).toEqual(before);
    expect(
      preferred
        .filter((value) => value.mimeType === "video/rtx")
        .map((value) => value.sdpFmtpLine),
    ).toEqual(["apt=96", "apt=102"]);
  });

  it("retains the browser ordering when it has no H264 capability", () => {
    const capabilities = [
      codec("VP9"),
      codec("rtx"),
      codec("red"),
      codec("VP8"),
    ];
    expect(preferredVideoCodecs(capabilities)).toEqual(capabilities);
    expect(preferredVideoCodecs([])).toEqual([]);
  });
});
