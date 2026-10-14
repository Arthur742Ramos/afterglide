/** Reorder media preferences without removing RTX, RED or FEC capabilities. */
export function preferredVideoCodecs(
  codecs: RTCRtpCodec[] = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [],
): RTCRtpCodec[] {
  const priority = (codec: RTCRtpCodec): number => {
    if (codec.mimeType.toLowerCase() !== "video/h264") return 4;
    const profile = codec.sdpFmtpLine?.match(
      /profile-level-id=([0-9a-f]+)/i,
    )?.[1];
    if (profile?.toLowerCase().startsWith("4d")) return 0;
    if (profile?.toLowerCase().startsWith("42e")) return 1;
    if (profile?.toLowerCase().startsWith("420")) return 2;
    return 3;
  };
  // Stable sorting preserves the browser's order within each preference group.
  return [...codecs].sort((left, right) => priority(left) - priority(right));
}
