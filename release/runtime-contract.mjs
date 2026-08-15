const SHA256 = /^[0-9a-f]{64}$/;

export const REQUIRED_PRODUCTION_RUNTIME_ASSETS = Object.freeze([
  Object.freeze({
    key: "hostWorker",
    path: "production-worker.mjs",
    role: "host-worker",
    mediaType: "text/javascript",
  }),
  Object.freeze({
    key: "workerInput",
    path: "worker-input.mjs",
    role: "host-input-bridge",
    mediaType: "text/javascript",
  }),
  Object.freeze({
    key: "pagedDisk",
    path: "paged-disk.mjs",
    role: "paged-disk-adapter",
    mediaType: "text/javascript",
  }),
  Object.freeze({
    key: "boundedOverlay",
    path: "bounded-overlay.mjs",
    role: "snapshot-overlay-guard",
    mediaType: "text/javascript",
  }),
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Bind the executable schema-2 runtime manifest to the four exact bootstrap
 * and storage records that make worker-paged production safe. Callers still
 * verify the record hashes against local files; this function prevents a
 * self-consistent manifest from omitting, aliasing, or relabelling a guard.
 */
export function validateProductionRuntimeContract(runtimeManifest, artifacts) {
  invariant(
    runtimeManifest?.schemaVersion === 2 && runtimeManifest?.runtimeMode === "worker-paged",
    "runtime manifest must use schema 2 worker-paged mode",
  );
  invariant(isRecord(runtimeManifest.assets), "runtime manifest is missing assets");
  invariant(
    !("preload" in runtimeManifest.assets) && !("data" in runtimeManifest.assets),
    "worker-paged runtime must not package preload or data assets",
  );
  invariant(Array.isArray(artifacts), "release artifact records are missing");

  for (const required of REQUIRED_PRODUCTION_RUNTIME_ASSETS) {
    invariant(
      runtimeManifest.assets[required.key] === required.path,
      `runtime manifest asset ${required.key} must be ${required.path}`,
    );

    const pathRecords = artifacts.filter((artifact) => artifact?.path === required.path);
    invariant(
      pathRecords.length === 1,
      `release must record ${required.path} exactly once`,
    );
    const roleRecords = artifacts.filter((artifact) => artifact?.role === required.role);
    invariant(
      roleRecords.length === 1,
      `release must record role ${required.role} exactly once`,
    );

    const [record] = pathRecords;
    invariant(
      record === roleRecords[0],
      `${required.path} must use role ${required.role}`,
    );
    invariant(
      record.mediaType === required.mediaType,
      `${required.path} must use media type ${required.mediaType}`,
    );
    invariant(
      Number.isSafeInteger(record.bytes) && record.bytes > 0,
      `${required.path} must record a positive byte length`,
    );
    invariant(
      SHA256.test(record.sha256 ?? ""),
      `${required.path} must record a canonical SHA-256`,
    );
  }

  return REQUIRED_PRODUCTION_RUNTIME_ASSETS.map(({ key, path, role, mediaType }) =>
    Object.freeze({ key, path, role, mediaType }));
}
