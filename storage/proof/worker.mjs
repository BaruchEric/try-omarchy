import createProof from "./dist/proof.mjs";
import { preparePagedDisk } from "/paged-disk.mjs";

const lines = [];
const runtimeRequests = [];

try {
  const metadataResponse = await fetch("/metadata.json", { cache: "no-store" });
  if (!metadataResponse.ok) throw new Error(`metadata HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  const disk = await preparePagedDisk({
    schemaVersion: 1,
    path: "/pack/rootfs.ext4",
    url: new URL(metadata.path, self.location.href).href,
    byteLength: metadata.bytes,
    sha256: metadata.sha256,
    chunkBytes: 1024 * 1024,
    maxCachedBytes: 2 * 1024 * 1024,
  }, {
    scope: self,
    origin: self.location.origin,
    onRequest: (request) => runtimeRequests.push(request),
  });

  await createProof({
    preRun: [disk.preRun],
    print: (line) => lines.push(String(line)),
    printErr: (line) => lines.push(`stderr: ${line}`),
  });

  self.postMessage({
    programPassed: lines.includes("PAGED_DISK_EMSCRIPTEN_PASS"),
    lines,
    preflight: disk.preflight,
    runtime: disk.snapshot(),
    runtimeRequests,
  });
} catch (error) {
  self.postMessage({
    programPassed: false,
    lines,
    runtimeRequests,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}
