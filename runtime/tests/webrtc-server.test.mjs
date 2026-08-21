import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createWebRtcPocServer } from "../scripts/serve-webrtc-poc.mjs";

async function fixture() {
  const server = createWebRtcPocServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("loopback WebRTC server creates an isolated offer/answer room", async (context) => {
  const app = await fixture();
  context.after(app.close);

  const create = await fetch(`${app.origin}/api/webrtc/sessions`, {
    method: "POST",
    headers: { "Content-Length": "0" },
  });
  assert.equal(create.status, 201);
  const room = await create.json();
  assert.match(room.sessionId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(app.server.sessionCount(), 1);

  const offer = {
    schemaVersion: 1,
    description: { type: "offer", sdp: "v=0\r\na=ice-ufrag:host\r\n" },
  };
  const published = await fetch(`${app.origin}/api/webrtc/sessions/${room.sessionId}/offer`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${room.hostToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(offer),
  });
  assert.equal(published.status, 204);

  const fetched = await fetch(
    `${app.origin}/api/webrtc/sessions/${room.sessionId}/offer?token=${room.viewerToken}`,
  );
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), offer);

  const answer = {
    schemaVersion: 1,
    description: { type: "answer", sdp: "v=0\r\na=ice-ufrag:viewer\r\n" },
  };
  const answered = await fetch(`${app.origin}/api/webrtc/sessions/${room.sessionId}/answer`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${room.viewerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(answer),
  });
  assert.equal(answered.status, 204);

  const hostAnswer = await fetch(
    `${app.origin}/api/webrtc/sessions/${room.sessionId}/answer?token=${room.hostToken}`,
  );
  assert.deepEqual(await hostAnswer.json(), answer);
});

test("loopback WebRTC server fails closed on tokens and malformed SDP", async (context) => {
  const app = await fixture();
  context.after(app.close);
  const room = await (await fetch(`${app.origin}/api/webrtc/sessions`, {
    method: "POST",
    headers: { "Content-Length": "0" },
  })).json();

  const hidden = await fetch(`${app.origin}/api/webrtc/sessions/${room.sessionId}/offer?token=wrong`);
  assert.equal(hidden.status, 404);

  const malformed = await fetch(`${app.origin}/api/webrtc/sessions/${room.sessionId}/offer`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${room.hostToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ schemaVersion: 1, description: { type: "offer", sdp: "bad" } }),
  });
  assert.equal(malformed.status, 400);

  const page = await fetch(`${app.origin}/webrtc-viewer.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("permissions-policy"), /display-capture/);
  assert.match(await page.text(), /Omarchy stream/);
});
