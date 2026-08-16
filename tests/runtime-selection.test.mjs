import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  ACTIVE_NATIVE_UPSTREAM,
  createNativeChallenge,
  launchNativeHelper,
  NATIVE_HELPER_ENDPOINT,
  normalizeNativeCapability,
  probeNativeHelper,
} from "../app/components/runtime-selection.mjs";

const challenge = "a".repeat(64);
const bundleIdentity = "b".repeat(64);

function capability(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "omarchy-native-helper",
    helperVersion: "0.1.0",
    challenge,
    hostArchitecture: "arm64",
    virtualizationAvailable: true,
    guestArchitectures: ["aarch64"],
    runtime: "apple-virtualization-framework",
    display: "native-window",
    supportsHostBoundResume: true,
    guest: {
      architecture: "aarch64",
      channel: "quattro",
      repository: ACTIVE_NATIVE_UPSTREAM.repository,
      commit: ACTIVE_NATIVE_UPSTREAM.commit,
      version: ACTIVE_NATIVE_UPSTREAM.version,
      treeSha256: ACTIVE_NATIVE_UPSTREAM.treeSha256,
      bundleIdentity,
    },
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("native challenge is 256 bits of fresh lowercase hex", () => {
  const first = createNativeChallenge(webcrypto);
  const second = createNativeChallenge(webcrypto);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test("normalizes only the exact ARM64 Quattro helper identity", () => {
  const value = normalizeNativeCapability(capability(), challenge);
  assert.equal(value.kind, "native-arm64");
  assert.equal(value.bundleIdentity, bundleIdentity);

  for (const mutation of [
    { challenge: "c".repeat(64) },
    { hostArchitecture: "x86_64" },
    { virtualizationAvailable: false },
    { guestArchitectures: ["aarch64", "x86_64"] },
    { runtime: "qemu-tcg" },
    { display: "browser-canvas" },
    { supportsHostBoundResume: false },
    { guest: { ...capability().guest, channel: "basecamp" } },
    { guest: { ...capability().guest, commit: "d".repeat(40) } },
    { extra: true },
  ]) {
    assert.equal(normalizeNativeCapability(capability(mutation), challenge), null);
  }
});

test("probe fails closed on absence and accepts a challenge-bound helper", async () => {
  const absent = await probeNativeHelper({
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(0xaa) },
  });
  assert.equal(absent, null);

  let requestedURL;
  const selected = await probeNativeHelper({
    fetchImpl: async (url, options) => {
      requestedURL = new URL(url);
      assert.equal(options.credentials, "omit");
      return jsonResponse(capability({ challenge: requestedURL.searchParams.get("challenge") }));
    },
    crypto: { getRandomValues: (bytes) => bytes.fill(0xaa) },
  });
  assert.equal(requestedURL.origin, NATIVE_HELPER_ENDPOINT);
  assert.equal(selected.kind, "native-arm64");
  assert.equal(selected.bundleIdentity, bundleIdentity);
});

test("launch accepts only an exact fresh receipt for the selected bundle", async () => {
  const runtime = normalizeNativeCapability(capability(), challenge);
  const receipt = await launchNativeHelper(runtime, {
    crypto: { getRandomValues: (bytes) => bytes.fill(0xcc) },
    fetchImpl: async (url, options) => {
      assert.equal(url, `${NATIVE_HELPER_ENDPOINT}/v1/launch`);
      assert.equal(options.credentials, "omit");
      const request = JSON.parse(options.body);
      assert.match(request.challenge, /^c{64}$/);
      return jsonResponse(
        {
          schemaVersion: 1,
          accepted: true,
          challenge: request.challenge,
          bundleIdentity,
          architecture: "aarch64",
          display: "native-window",
        },
        202,
      );
    },
  });
  assert.equal(receipt.bundleIdentity, bundleIdentity);

  await assert.rejects(
    launchNativeHelper(runtime, {
      crypto: { getRandomValues: (bytes) => bytes.fill(0xdd) },
      fetchImpl: async () =>
        jsonResponse(
          {
            schemaVersion: 1,
            accepted: true,
            challenge: "d".repeat(64),
            bundleIdentity: "e".repeat(64),
            architecture: "aarch64",
            display: "native-window",
          },
          202,
        ),
    }),
    /invalid launch receipt/,
  );
});

test("launch reports an already-running native VM without falling through", async () => {
  const runtime = normalizeNativeCapability(capability(), challenge);
  await assert.rejects(
    launchNativeHelper(runtime, {
      crypto: { getRandomValues: (bytes) => bytes.fill(0xee) },
      fetchImpl: async () => jsonResponse({ error: "already running" }, 409),
    }),
    /already running/,
  );
});
