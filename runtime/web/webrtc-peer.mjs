export function readCredential(name, pattern) {
  const value = new URLSearchParams(location.search).get(name) ?? "";
  if (!pattern.test(value)) throw new Error(`The ${name} credential is missing or invalid.`);
  return value;
}

export function waitForIceGathering(peer, timeoutMs = 15000) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("ICE gathering timed out."));
    }, timeoutMs);
    function changed() {
      if (peer.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

export async function publishDescription({ room, side, token, description }) {
  const response = await fetch(`/api/webrtc/sessions/${room}/${side}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ schemaVersion: 1, description }),
  });
  if (response.status !== 204) throw new Error(`${side} publication failed (${response.status}).`);
}

export async function pollDescription({ room, side, token, signal, timeoutMs = 120000 }) {
  const deadline = performance.now() + timeoutMs;
  while (!signal.aborted && performance.now() < deadline) {
    const response = await fetch(
      `/api/webrtc/sessions/${room}/${side}?token=${encodeURIComponent(token)}`,
      { cache: "no-store", signal },
    );
    if (response.status === 200) {
      const value = await response.json();
      if (value?.schemaVersion === 1 && value.description?.type === side &&
          typeof value.description.sdp === "string") return value.description;
      throw new Error(`The ${side} response was malformed.`);
    }
    if (response.status !== 204) throw new Error(`${side} polling failed (${response.status}).`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 250);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }
  throw new Error(`Timed out waiting for ${side}.`);
}

export function createPeer() {
  return new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
}

export function setConnectionBadge(element, state, label = state) {
  element.dataset.state = state;
  element.textContent = label.toUpperCase();
}
