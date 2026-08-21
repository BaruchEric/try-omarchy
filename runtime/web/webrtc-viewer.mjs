import { encodeStreamInput } from "/webrtc-protocol.mjs";
import {
  createPeer,
  pollDescription,
  publishDescription,
  readCredential,
  setConnectionBadge,
  waitForIceGathering,
} from "/webrtc-peer.mjs";

const ROOM_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const room = readCredential("room", ROOM_PATTERN);
const token = readCredential("token", TOKEN_PATTERN);
const params = new URLSearchParams(location.search);

const video = document.getElementById("remote-video");
const frame = document.getElementById("viewer-frame");
const placeholder = document.getElementById("video-placeholder");
const connectButton = document.getElementById("connect");
const statusElement = document.getElementById("viewer-status");
const connectionState = document.getElementById("connection-state");
const fullscreenButton = document.getElementById("fullscreen");
const metricFps = document.getElementById("metric-fps");
const metricDecoded = document.getElementById("metric-decoded");
const metricBitrate = document.getElementById("metric-bitrate");
const metricLoss = document.getElementById("metric-loss");
const metricInput = document.getElementById("metric-input");
const streamSource = document.getElementById("stream-source");

let peer = null;
let inputChannel = null;
let sequence = 0;
let firstFrame = false;
let frameObserverStarted = false;
let lastFrameAt = 0;
let frameTimes = [];
let inputAcknowledgements = 0;
let pendingPointer = null;
let pointerFrame = 0;
let previousBytes = 0;
let previousStatsAt = 0;
let previousDecoded = 0;
const pressedKeys = new Set();
const abortController = new AbortController();
const SHORTCUTS = Object.freeze({
  menu: ["MetaLeft", "Space"],
  terminal: ["MetaLeft", "Enter"],
  close: ["MetaLeft", "KeyW"],
});

function status(message, error = false) {
  statusElement.textContent = message;
  statusElement.dataset.error = String(error);
}

function nextSequence() {
  sequence += 1;
  return sequence;
}

function canSendInput() {
  return inputChannel?.readyState === "open";
}

function sendInput(event, { droppable = false } = {}) {
  if (!canSendInput()) return false;
  if (droppable && inputChannel.bufferedAmount > 256 * 1024) return false;
  inputChannel.send(encodeStreamInput({ ...event, sequence: nextSequence() }));
  return true;
}

function cancelPendingPointer() {
  if (pointerFrame) cancelAnimationFrame(pointerFrame);
  pointerFrame = 0;
  pendingPointer = null;
}

function releaseAll() {
  cancelPendingPointer();
  if (!pressedKeys.size && !canSendInput()) return;
  pressedKeys.clear();
  sendInput({ kind: "release-all" });
}

function videoPoint(event) {
  const bounds = video.getBoundingClientRect();
  const sourceWidth = video.videoWidth || 1600;
  const sourceHeight = video.videoHeight || 900;
  const scale = Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const left = bounds.left + (bounds.width - width) / 2;
  const top = bounds.top + (bounds.height - height) / 2;
  return {
    x: Math.min(1, Math.max(0, (event.clientX - left) / width)),
    y: Math.min(1, Math.max(0, (event.clientY - top) / height)),
  };
}

function queuePointer(event) {
  const point = videoPoint(event);
  pendingPointer = { kind: "pointer", ...point, buttons: event.buttons };
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    if (pendingPointer) sendInput(pendingPointer, { droppable: true });
    pendingPointer = null;
  });
}

function sendPointerNow(event) {
  cancelPendingPointer();
  sendInput({ kind: "pointer", ...videoPoint(event), buttons: event.buttons });
}

function updateReady() {
  const ready = peer?.connectionState === "connected" &&
    inputChannel?.readyState === "open" && firstFrame;
  if (!ready) return;
  placeholder.hidden = true;
  setConnectionBadge(connectionState, "ready", "LIVE");
  status("Live. Click the desktop to control Omarchy.");
  video.focus();
}

function countFrames(now) {
  firstFrame = true;
  lastFrameAt = performance.now();
  frameTimes.push(now);
  const cutoff = now - 1000;
  frameTimes = frameTimes.filter((time) => time >= cutoff);
  metricFps.textContent = String(frameTimes.length);
  updateReady();
  video.requestVideoFrameCallback(countFrames);
}

function observeFirstFrame() {
  if (!frameObserverStarted && typeof video.requestVideoFrameCallback === "function") {
    frameObserverStarted = true;
    video.requestVideoFrameCallback(countFrames);
  }
}

function bindInput(channel) {
  if (channel.label !== "omarchy-input") {
    channel.close();
    return;
  }
  inputChannel = channel;
  channel.addEventListener("open", updateReady);
  channel.addEventListener("message", (message) => {
    try {
      const value = JSON.parse(message.data);
      if (value?.type === "source" &&
          ["test-pattern", "user-selected-window"].includes(value.kind) &&
          typeof value.label === "string" && value.label.length <= 96 &&
          Object.keys(value).length === 3) {
        streamSource.textContent = value.label;
      } else if (value?.type === "input-ack" && Number.isSafeInteger(value.sequence) &&
          typeof value.delivered === "boolean" && Object.keys(value).length === 3) {
        if (value.delivered) {
          inputAcknowledgements += 1;
          metricInput.textContent = String(inputAcknowledgements);
        } else {
          status(`Input #${value.sequence} reached the host but not the native VM.`, true);
        }
      }
    } catch {
      // Ignore non-protocol data.
    }
  });
  channel.addEventListener("close", releaseAll);
}

async function connect() {
  connectButton.disabled = true;
  status("Waiting for the capture host offer…");
  try {
    peer = createPeer();
    peer.addEventListener("track", (event) => {
      if (event.track.kind !== "video") return;
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      video.play();
      video.addEventListener("playing", observeFirstFrame, { once: true });
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) observeFirstFrame();
    });
    peer.addEventListener("datachannel", (event) => bindInput(event.channel));
    peer.addEventListener("connectionstatechange", () => {
      const state = peer.connectionState;
      if (state !== "connected") setConnectionBadge(connectionState, state, state);
      if (state === "failed") status("WebRTC failed. Create a fresh room and retry.", true);
      updateReady();
    });
    const offer = await pollDescription({
      room,
      side: "offer",
      token,
      signal: abortController.signal,
    });
    await peer.setRemoteDescription(offer);
    await peer.setLocalDescription(await peer.createAnswer());
    await waitForIceGathering(peer);
    await publishDescription({ room, side: "answer", token, description: peer.localDescription });
    status("Answer published. Establishing the encrypted peer connection…");
  } catch (error) {
    status(error.message, true);
    setConnectionBadge(connectionState, "error", "ERROR");
    connectButton.disabled = false;
  }
}

video.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  pressedKeys.add(event.code);
  if (sendInput({ kind: "key", code: event.code, down: true })) event.preventDefault();
});
video.addEventListener("keyup", (event) => {
  pressedKeys.delete(event.code);
  if (sendInput({ kind: "key", code: event.code, down: false })) event.preventDefault();
});
video.addEventListener("pointerdown", (event) => {
  video.focus();
  video.setPointerCapture(event.pointerId);
  sendPointerNow(event);
  event.preventDefault();
});
video.addEventListener("pointermove", queuePointer);
video.addEventListener("pointerup", (event) => {
  sendPointerNow(event);
  if (video.hasPointerCapture(event.pointerId)) video.releasePointerCapture(event.pointerId);
  event.preventDefault();
});
video.addEventListener("pointercancel", releaseAll);
video.addEventListener("lostpointercapture", releaseAll);
video.addEventListener("wheel", (event) => {
  if (sendInput({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY })) {
    event.preventDefault();
  }
}, { passive: false });
video.addEventListener("blur", releaseAll);
document.querySelectorAll("[data-shortcut]").forEach((button) => {
  button.addEventListener("click", () => {
    const codes = SHORTCUTS[button.dataset.shortcut];
    if (!codes || !canSendInput()) return;
    for (const code of codes) sendInput({ kind: "key", code, down: true });
    for (const code of [...codes].reverse()) sendInput({ kind: "key", code, down: false });
    video.focus();
  });
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAll();
});
addEventListener("pagehide", () => {
  releaseAll();
  abortController.abort();
  inputChannel?.close();
  peer?.close();
});

fullscreenButton.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await frame.requestFullscreen();
  video.focus();
});
connectButton.addEventListener("click", connect);

setInterval(async () => {
  if (!peer) return;
  const reports = await peer.getStats();
  for (const report of reports.values()) {
    if (report.type !== "inbound-rtp" || (report.kind ?? report.mediaType) !== "video") continue;
    const decoded = report.framesDecoded ?? 0;
    metricDecoded.textContent = String(decoded);
    metricLoss.textContent = String(report.packetsLost ?? 0);
    const now = report.timestamp ?? performance.now();
    const bytes = report.bytesReceived ?? 0;
    if (decoded > previousDecoded) {
      lastFrameAt = performance.now();
      if (typeof video.requestVideoFrameCallback !== "function") {
        firstFrame = true;
        updateReady();
      }
    }
    if (previousStatsAt && now > previousStatsAt) {
      const bitsPerSecond = ((bytes - previousBytes) * 8 * 1000) / (now - previousStatsAt);
      metricBitrate.textContent = `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
      if (typeof video.requestVideoFrameCallback !== "function") {
        const framesPerSecond = ((decoded - previousDecoded) * 1000) / (now - previousStatsAt);
        metricFps.textContent = String(Math.max(0, Math.round(framesPerSecond)));
      }
    }
    previousBytes = bytes;
    previousStatsAt = now;
    previousDecoded = decoded;
  }
  if (lastFrameAt && performance.now() - lastFrameAt > 1200) {
    frameTimes = [];
    metricFps.textContent = "0";
  }
}, 1000);

if (params.get("autostart") === "1") connectButton.click();
