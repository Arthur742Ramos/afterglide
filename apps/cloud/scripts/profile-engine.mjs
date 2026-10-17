// Bundled for the isolated profiler, never part of the shipped application.
import { XboxStreamEngine } from "../src/renderer/stream/stream-engine.ts";
import { defaultControllerTuning } from "../src/shared/contracts.ts";

export function initializeReceiver() {
  const state = {
    engine: undefined,
    pending: 0,
    settled: 0,
    connected: 0,
    iceRequests: 0,
    errors: [],
    telemetry: [],
  };
  window.__receiverProfile = state;
  window.afterglideCloud = {
    sendSdp: (_id, offer) => window.__profileAnswer(offer),
    sendIce: (_id, candidates) => {
      state.iceRequests++;
      return window.__profileIce(candidates);
    },
    keepalive: async () => {},
  };
}

export function startReceiver(holdIce = false) {
  const state = window.__receiverProfile;
  window.__clientProfile.state.holdIce = holdIce;
  state.engine = new XboxStreamEngine({
    sessionId: "local-performance-fixture",
    container: document.body,
    keyboardControls: true,
    playbackSettings: {
      volume: 0,
      muted: true,
      videoFit: "fit",
      inputPolling: "responsive",
      playbackMode: "automatic",
    },
    controllerSettings: {
      preferredControllerId: "",
      controllerDefaults: defaultControllerTuning,
      controllerProfiles: [],
    },
    onConnected: () => state.connected++,
    onInterrupted: () => state.errors.push("interrupted"),
    onError: (message) => state.errors.push(message),
    onTelemetry: (value) => {
      state.telemetry.push(value);
      if (state.telemetry.length > 100) state.telemetry.shift();
    },
    onControllerStatus() {},
  });
  state.pending++;
  void state.engine.connect().finally(() => {
    state.pending--;
    state.settled++;
  });
}

export function stopReceiver() {
  window.__receiverProfile.engine?.destroy();
  window.__receiverProfile.engine = undefined;
}

export async function answerOffer(offer) {
  const peer = new RTCPeerConnection({});
  const candidates = [];
  const channels = [];
  const packets = [];
  const messageKinds = [];
  peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) candidates.push(event.candidate.toJSON());
  });
  peer.addEventListener("datachannel", ({ channel }) => {
    channels.push(channel);
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", (event) => {
      if (channel.label === "message") {
        messageKinds.push({
          kind: typeof event.data,
          type:
            typeof event.data === "string"
              ? JSON.parse(event.data).type
              : "binary",
        });
        try {
          if (JSON.parse(event.data).type === "Handshake")
            channel.send(JSON.stringify({ type: "HandshakeAck" }));
        } catch {
          /* Other message types do not affect the local fixture. */
        }
      } else if (
        channel.label === "input" &&
        event.data instanceof ArrayBuffer &&
        event.data.byteLength === 38
      ) {
        const packet = new DataView(event.data);
        packets.push({
          sentAt: packet.getFloat64(6, true),
          mask: packet.getUint16(16, true),
        });
        if (packets.length > 1000) packets.shift();
      }
    });
  });
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  let frame = 0;
  const draw = setInterval(() => {
    context.fillStyle = frame++ % 2 ? "#2050b0" : "#f8c050";
    context.fillRect(0, 0, 640, 360);
  }, 33);
  const stream = canvas.captureStream(30);
  const audio = new AudioContext();
  const oscillator = audio.createOscillator();
  const silent = audio.createGain();
  silent.gain.value = 0;
  const destination = audio.createMediaStreamDestination();
  oscillator.connect(silent).connect(destination);
  oscillator.start();
  await audio.resume();
  for (const track of [
    ...stream.getTracks(),
    ...destination.stream.getTracks(),
  ])
    peer.addTrack(track);
  window.__senderProfile = {
    peer,
    candidates,
    channels,
    packets,
    messageKinds,
    stream,
    audio,
    oscillator,
    destination,
    draw,
  };
  await peer.setRemoteDescription(offer);
  await peer.setLocalDescription(await peer.createAnswer());
  return { sdp: peer.localDescription.sdp };
}

export async function exchangeIce(candidates) {
  const state = window.__senderProfile;
  for (const candidate of candidates)
    await state.peer.addIceCandidate(candidate);
  for (let i = 0; i < 100 && state.peer.iceGatheringState !== "complete"; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return state.candidates;
}

export async function stopSender() {
  const state = window.__senderProfile;
  if (!state) return;
  clearInterval(state.draw);
  state.channels.forEach((channel) => channel.close());
  const tracks = [
    ...state.stream.getTracks(),
    ...state.destination.stream.getTracks(),
  ];
  tracks.forEach((track) => track.stop());
  state.oscillator.stop();
  await state.audio.close();
  state.peer.close();
  window.__senderProfile = undefined;
  return {
    connection: state.peer.connectionState,
    tracks: tracks.map((track) => track.readyState),
  };
}
