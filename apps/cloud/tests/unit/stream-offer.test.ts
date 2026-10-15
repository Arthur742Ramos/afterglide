import { expect, it } from "vitest";
import { prepareStreamOffer } from "../../src/renderer/stream/stream-offer";

it.each(["\r\n", "\n"])(
  "declines sender playout timing while preserving the rest of the offer (%j)",
  (newline) => {
    const kept = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
      "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
      "a=rtpmap:96 H264/90000",
      "a=rtpmap:97 rtx/90000",
      "a=fmtp:97 apt=96",
      "a=rtcp-fb:96 nack",
      "",
    ];
    const offer = [...kept];
    offer.splice(
      3,
      0,
      "a=extmap:5/recvonly http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
    );
    expect(prepareStreamOffer(offer.join(newline))).toBe(kept.join(newline));
  },
);

it("retains stereo Opus negotiation when playout delay is absent", () => {
  expect(prepareStreamOffer("a=fmtp:111 useinbandfec=1\r\n")).toBe(
    "a=fmtp:111 useinbandfec=1; stereo=1\r\n",
  );
});
