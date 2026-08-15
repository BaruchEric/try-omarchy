import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ACTIVE_UPSTREAM } from "../../app/components/vm-ui-state.mjs";
import { CANONICAL_PRODUCTION_RUNTIME_MANIFEST } from "../../release/runtime-contract.mjs";
import {
  hibernationProducerDocument,
  hibernationProfile,
  hibernationRuntimeManifest,
} from "../../release/tests/checkpoint-fixture.mjs";
import {
  fetchVerifiedWorkerBootstrap,
  normalizeRuntimeHibernationResume,
} from "../../public/vm/host-utils.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function artifact(path, role, mediaType, bytes, digest = sha256(bytes)) {
  return {
    path,
    role,
    mediaType,
    bytes: bytes.byteLength,
    sha256: digest,
  };
}

function response(bytes, contentType) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
    },
  });
}

function fixture({ mutateRuntime, mutateProducer, mutateArtifacts } = {}) {
  const workerBytes = new TextEncoder().encode("self.onmessage = () => {};\n");
  let profile = hibernationProfile({ upstream: ACTIVE_UPSTREAM });
  let producer = hibernationProducerDocument(profile, ACTIVE_UPSTREAM);
  mutateProducer?.(producer, profile);
  const producerBytes = jsonBytes(producer);
  profile = {
    ...profile,
    producer: {
      ...profile.producer,
      manifestBytes: producerBytes.byteLength,
      manifestSha256: sha256(producerBytes),
    },
  };
  let runtime = hibernationRuntimeManifest(
    CANONICAL_PRODUCTION_RUNTIME_MANIFEST,
    profile,
  );
  mutateRuntime?.(runtime, profile);
  const runtimeBytes = jsonBytes(runtime);
  const opaque = new Uint8Array([1]);
  const artifacts = [
    artifact("production-worker.mjs", "host-worker", "text/javascript", workerBytes),
    artifact("runtime-manifest.json", "runtime-config", "application/json", runtimeBytes),
    artifact(
      profile.derivedInitramfs.artifactPath,
      "hibernation-initramfs",
      "application/vnd.linux.initramfs",
      opaque,
      profile.derivedInitramfs.sha256,
    ),
    artifact(
      profile.rootDelta.artifactPath,
      "hibernation-root-delta",
      "application/vnd.qemu.qcow2",
      opaque,
      profile.rootDelta.sha256,
    ),
    artifact(
      profile.swapImage.artifactPath,
      "hibernation-swap-image",
      "application/vnd.qemu.qcow2",
      opaque,
      profile.swapImage.sha256,
    ),
    artifact(
      profile.producer.manifestArtifactPath,
      "hibernation-metadata",
      "application/json",
      producerBytes,
    ),
  ];
  for (const descriptor of [
    profile.derivedInitramfs,
    profile.rootDelta,
    profile.swapImage,
  ]) {
    const record = artifacts.find(({ path }) => path === descriptor.artifactPath);
    record.bytes = descriptor.bytes;
  }
  mutateArtifacts?.(artifacts, profile);
  const manifestBytes = jsonBytes({
    schemaVersion: 1,
    upstream: { ...ACTIVE_UPSTREAM },
    artifacts,
  });
  const releaseId = sha256(manifestBytes);
  const bodies = new Map([
    ["artifact-manifest.json", [manifestBytes, "application/json"]],
    ["production-worker.mjs", [workerBytes, "text/javascript"]],
    ["runtime-manifest.json", [runtimeBytes, "application/json"]],
    [profile.producer.manifestArtifactPath, [producerBytes, "application/json"]],
  ]);
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname.split("/").at(-1);
    const entry = bodies.get(path);
    return entry ? response(...entry) : new Response("not found", { status: 404 });
  };
  return {
    releaseId,
    releaseBaseUrl: new URL(`https://try.example/omarchy/versions/${releaseId}/`),
    fetchImpl,
    profile,
  };
}

test("verified bootstrap binds the descriptor digest and fresh hibernation provenance", async () => {
  const value = fixture();
  const bootstrap = await fetchVerifiedWorkerBootstrap({
    ...value,
    expectedReleaseId: value.releaseId,
  });
  assert.deepEqual(bootstrap.guestReportProvenance, {
    origin: "live-hibernation-serial",
    resume: {
      descriptorSha256: value.profile.producer.manifestSha256,
      markerSha256: value.profile.resumeEvidence.hibernationMarkerSha256,
      sourceBootId: value.profile.restoreContract.sourceBootId,
      swapUuid: value.profile.swapImage.swapUuid,
    },
  });
  assert.equal(
    bootstrap.hibernationResume.descriptorSha256,
    value.profile.producer.manifestSha256,
  );
  assert.equal(bootstrap.hibernationResume.renderer, "virgl");
  assert.equal(
    Object.hasOwn(bootstrap.hibernationResume, "rendererReportSha256"),
    false,
  );
  assert.equal(bootstrap.checkpointGuestReport, null);

  const liveRendererReportSha256 = "f".repeat(64);
  assert.notEqual(
    liveRendererReportSha256,
    value.profile.resumeEvidence.rendererProbeSha256,
  );
  const liveMessage = {
    type: "hibernationresume",
    evidence: {
      ...bootstrap.hibernationResume,
      rendererReportSha256: liveRendererReportSha256,
    },
  };
  assert.deepEqual(
    normalizeRuntimeHibernationResume(liveMessage, bootstrap),
    liveMessage.evidence,
  );
  assert.equal(
    normalizeRuntimeHibernationResume({
      ...liveMessage,
      evidence: {
        ...liveMessage.evidence,
        descriptorSha256: "e".repeat(64),
      },
    }, bootstrap),
    null,
  );
  assert.equal(
    normalizeRuntimeHibernationResume({
      ...liveMessage,
      evidence: {
        ...liveMessage.evidence,
        rendererReportSha256: "not-a-digest",
      },
    }, bootstrap),
    null,
  );
});

test("verified bootstrap rejects hibernation omission, mutation, and cold downgrade", async (t) => {
  const hostile = [
    ["missing source field", {
      mutateProducer(document) {
        delete document.sourceEvidence.hibernationEntryMarkerSha256;
      },
    }],
    ["nonce replay", {
      mutateProducer(document) {
        document.sourceEvidence.nonceSha256 = "f".repeat(64);
      },
    }],
    ["resume evidence mutation", {
      mutateProducer(document) {
        document.resumeEvidence.rendererProbeSha256 = "f".repeat(64);
      },
    }],
    ["direct software renderer downgrade", {
      mutateProducer(document, profile) {
        const renderer = "llvmpipe (LLVM 20.1.8, 256 bits)";
        document.resumeEvidence.renderer = renderer;
        profile.resumeEvidence.renderer = renderer;
      },
    }],
    ["artifact identity mutation", {
      mutateArtifacts(artifacts, profile) {
        artifacts.find(({ path }) => path === profile.swapImage.artifactPath).sha256 =
          "f".repeat(64);
      },
    }],
    ["cold downgrade", {
      mutateRuntime(runtime) {
        delete runtime.checkpoint;
        runtime.guest = structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST.guest);
        runtime.qemu = structuredClone(CANONICAL_PRODUCTION_RUNTIME_MANIFEST.qemu);
      },
    }],
  ];
  for (const [name, options] of hostile) {
    await t.test(name, async () => {
      const value = fixture(options);
      await assert.rejects(
        fetchVerifiedWorkerBootstrap({
          ...value,
          expectedReleaseId: value.releaseId,
        }),
        /hibernation|resume|cold runtime/i,
      );
    });
  }
});
