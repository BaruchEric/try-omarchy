const createButton = document.getElementById("create-session");
const status = document.getElementById("create-status");
const roomCard = document.getElementById("room-card");
const hostLink = document.getElementById("host-link");
const viewerLink = document.getElementById("viewer-link");

createButton.addEventListener("click", async () => {
  createButton.disabled = true;
  status.textContent = "Creating an isolated signaling room…";
  try {
    const response = await fetch("/api/webrtc/sessions", {
      method: "POST",
      headers: { "Content-Length": "0" },
    });
    if (response.status !== 201) throw new Error(`server returned ${response.status}`);
    const room = await response.json();
    const host = new URL("/webrtc-host.html", location.origin);
    host.searchParams.set("room", room.sessionId);
    host.searchParams.set("hostToken", room.hostToken);
    host.searchParams.set("viewerToken", room.viewerToken);
    const viewer = new URL("/webrtc-viewer.html", location.origin);
    viewer.searchParams.set("room", room.sessionId);
    viewer.searchParams.set("token", room.viewerToken);
    hostLink.href = host.href;
    viewerLink.href = viewer.href;
    roomCard.hidden = false;
    status.textContent = "Room ready. Open the capture host first.";
  } catch (error) {
    status.dataset.error = "true";
    status.textContent = `Could not create the room: ${error.message}`;
    createButton.disabled = false;
  }
});
