/** Keep presentation timing under the receiver's control. */
export function prepareStreamOffer(sdp: string): string {
  // A sender's zero maximum playout delay can override jitterBufferTarget
  // and make Chromium replace frames without its normal presentation queue.
  // Decline only this optional extension; keep transport timing and repair.
  return sdp
    .replace(
      /^a=extmap:\d+(?:\/\w+)? http:\/\/www\.webrtc\.org\/experiments\/rtp-hdrext\/playout-delay(?:[^\r\n]*)\r?\n/gm,
      "",
    )
    .replace("useinbandfec=1", "useinbandfec=1; stereo=1");
}
