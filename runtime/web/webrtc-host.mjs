import { decodeStreamInput } from "/webrtc-protocol.mjs";
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
const HELPER_ENDPOINT = "http://127.0.0.1:11555";
const room = readCredential("room", ROOM_PATTERN);
const hostToken = readCredential("hostToken", TOKEN_PATTERN);
const viewerToken = readCredential("viewerToken", TOKEN_PATTERN);
const params = new URLSearchParams(location.search);

const connectionState = document.getElementById("connection-state");
const hostStatus = document.getElementById("host-status");
const launchButton = document.getElementById("launch-native");
const shareButton = document.getElementById("share-window");
const testButton = document.getElementById("test-pattern");
const localVideo = document.getElementById("local-video");
const placeholder = document.getElementById("video-placeholder");
const sourceLabel = document.getElementById("source-label");
const viewerURL = document.getElementById("viewer-url");
const copyButton = document.getElementById("copy-viewer");
const inputLog = document.getElementById("input-log");
const hostMetrics = document.getElementById("host-metrics");
const testCanvas = document.getElementById("test-canvas");

const viewer = new URL("/webrtc-viewer.html", location.origin);
viewer.searchParams.set("room", room);
viewer.searchParams.set("token", viewerToken);
viewerURL.value = viewer.href;

let peer = null;
let inputChannel = null;
let nativeSessionToken = null;
let abortController = new AbortController();
let testPatternStop = null;
let inputTail = Promise.resolve();
let receivedInputs = 0;
const inputLines = [];

function status(message, error = false) {
  hostStatus.textContent = message;
  hostStatus.dataset.error = String(error);
}

function challenge() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function launchNative() {
  launchButton.disabled = true;
  status("Checking the signed native helper and Quattro bundle…");
  const sessionToken = challenge();
  try {
    const capabilities = await fetch(
      `${HELPER_ENDPOINT}/v1/capabilities?challenge=${sessionToken}`,
      { cache: "no-store", credentials: "omit" },
    );
    if (capabilities.status !== 200) throw new Error(`helper probe returned ${capabilities.status}`);
    const report = await capabilities.json();
    if (report?.challenge !== sessionToken || report?.kind !== "omarchy-native-helper" ||
        report?.guest?.channel !== "quattro" || report?.virtualizationAvailable !== true) {
      throw new Error("helper identity did not match the ARM64 Quattro contract");
    }
    const launched = await fetch(`${HELPER_ENDPOINT}/v1/launch`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, challenge: sessionToken }),
    });
    if (launched.status !== 202) {
      throw new Error(launched.status === 409
        ? "a native VM is already running; restart the helper to bind remote input"
        : `launch returned ${launched.status}`);
    }
    const receipt = await launched.json();
    if (receipt?.challenge !== sessionToken || receipt?.accepted !== true) {
      throw new Error("helper returned an invalid launch receipt");
    }
    nativeSessionToken = sessionToken;
    hostMetrics.children[2].querySelector("i").textContent = "native helper";
    status("Native Omarchy launched. Now share the Omarchy window.");
  } catch (error) {
    launchButton.disabled = false;
    status(`Native launch unavailable: ${error.message}. Start the helper for ${location.origin}.`, true);
  }
}

function drawTestPattern() {
  const context = testCanvas.getContext("2d", { alpha: false });
  const stream = testCanvas.captureStream(60);
  const track = stream.getVideoTracks()[0];
  let frame = 0;
  let stopped = false;
  const worker = new Worker(URL.createObjectURL(new Blob([
    "let live=true;function tick(){if(!live)return;postMessage(0);setTimeout(tick,16)};onmessage=e=>{if(e.data==='stop')live=false};tick();",
  ], { type: "text/javascript" })));
  worker.onmessage = () => {
    if (stopped) return;
    const width = testCanvas.width;
    const height = testCanvas.height;
    const hue = (frame * 2) % 360;
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${hue} 48% 12%)`);
    gradient.addColorStop(1, `hsl(${(hue + 80) % 360} 54% 24%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#d9ff43";
    context.fillRect((frame * 19) % (width + 220) - 220, 260, 220, 220);
    context.fillStyle = "#f2f5f4";
    context.font = "700 74px ui-monospace, monospace";
    context.fillText("OMARCHY / WEBRTC", 72, 120);
    context.font = "36px ui-monospace, monospace";
    context.fillText(`FRAME ${String(frame).padStart(8, "0")}`, 72, 760);
    context.fillText(new Date().toISOString(), 72, 820);
    track.requestFrame?.();
    frame += 1;
  };
  testPatternStop = () => {
    stopped = true;
    worker.postMessage("stop");
    worker.terminate();
  };
  return stream;
}

async function shareWindow() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "window",
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1600 },
        height: { ideal: 900 },
      },
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
    });
    await publishStream(stream, "OMARCHY WINDOW");
  } catch (error) {
    if (error?.name !== "NotAllowedError") status(`Window capture failed: ${error.message}`, true);
  }
}

function logInput(event, delivered) {
  receivedInputs += 1;
  inputLines.push(`#${event.sequence} ${event.kind}${delivered ? " → native" : " → test"}`);
  while (inputLines.length > 40) inputLines.shift();
  inputLog.textContent = inputLines.join("\n");
  hostMetrics.children[1].querySelector("i").textContent = `${receivedInputs} received`;
}

function acknowledge(event, delivered) {
  if (inputChannel?.readyState !== "open") return;
  inputChannel.send(JSON.stringify({
    type: "input-ack",
    sequence: event.sequence,
    delivered,
  }));
}

function relayInput(event) {
  if (nativeSessionToken === null) {
    logInput(event, false);
    acknowledge(event, false);
    return;
  }
  inputTail = inputTail.then(async () => {
    try {
      const response = await fetch(`${HELPER_ENDPOINT}/v1/input`, {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, sessionToken: nativeSessionToken, event }),
      });
      const delivered = response.status === 202;
      logInput(event, delivered);
      acknowledge(event, delivered);
      if (!delivered) status(`Native input relay rejected event #${event.sequence}.`, true);
    } catch (error) {
      logInput(event, false);
      acknowledge(event, false);
      status(`Native input relay failed: ${error.message}`, true);
    }
  });
}

function bindInputChannel(channel) {
  inputChannel = channel;
  channel.addEventListener("open", () => {
    hostMetrics.children[1].querySelector("i").textContent = "channel open";
  });
  channel.addEventListener("message", (message) => {
    const event = decodeStreamInput(message.data);
    if (event !== null) relayInput(event);
  });
  channel.addEventListener("close", () => {
    hostMetrics.children[1].querySelector("i").textContent = "channel closed";
  });
}

async function publishStream(stream, label) {
  if (peer !== null) throw new Error("This room already published a stream.");
  shareButton.disabled = true;
  testButton.disabled = true;
  placeholder.hidden = true;
  sourceLabel.textContent = label;
  localVideo.srcObject = stream;
  await localVideo.play();

  const track = stream.getVideoTracks()[0];
  track.contentHint = "motion";
  track.addEventListener("ended", teardown, { once: true });
  peer = createPeer();
  const transceiver = peer.addTransceiver(track, { direction: "sendonly", streams: [stream] });
  const capabilities = RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
  const preferred = [
    ...capabilities.filter((codec) => codec.mimeType === "video/H264"),
    ...capabilities.filter((codec) => codec.mimeType !== "video/H264"),
  ];
  if (preferred.length && typeof transceiver.setCodecPreferences === "function") {
    transceiver.setCodecPreferences(preferred);
  }
  try {
    const parameters = transceiver.sender.getParameters();
    parameters.degradationPreference = "maintain-framerate";
    await transceiver.sender.setParameters(parameters);
  } catch {
    // Older engines may not expose degradationPreference; negotiation still works.
  }
  bindInputChannel(peer.createDataChannel("omarchy-input", { ordered: true }));
  peer.addEventListener("connectionstatechange", () => {
    const state = peer.connectionState;
    hostMetrics.children[0].querySelector("i").textContent = state;
    setConnectionBadge(connectionState, state === "connected" ? "ready" : state, state);
    if (state === "connected") status("Viewer connected. Video and input are live over WebRTC.");
    if (state === "failed") status("The peer connection failed. Create a fresh room.", true);
  });

  status("Gathering local ICE candidates…");
  await peer.setLocalDescription(await peer.createOffer());
  await waitForIceGathering(peer);
  await publishDescription({ room, side: "offer", token: hostToken, description: peer.localDescription });
  status("Offer published. Waiting for the viewer…");
  const answer = await pollDescription({
    room,
    side: "answer",
    token: hostToken,
    signal: abortController.signal,
  });
  await peer.setRemoteDescription(answer);
}

async function teardown() {
  abortController.abort();
  abortController = new AbortController();
  inputChannel?.close();
  peer?.close();
  peer = null;
  localVideo.srcObject?.getTracks().forEach((track) => track.stop());
  localVideo.srcObject = null;
  testPatternStop?.();
  testPatternStop = null;
}

launchButton.addEventListener("click", launchNative);
shareButton.addEventListener("click", shareWindow);
testButton.addEventListener("click", async () => {
  try {
    await publishStream(drawTestPattern(), "60 FPS TEST");
  } catch (error) {
    status(error.message, true);
  }
});
copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(viewerURL.value);
  copyButton.textContent = "Copied";
});
addEventListener("pagehide", () => {
  teardown();
  fetch(`/api/webrtc/sessions/${room}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${hostToken}` },
    keepalive: true,
  });
});

if (params.get("autostart") === "test") testButton.click();
