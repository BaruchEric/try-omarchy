import createProof from "./dist/proof.mjs";
import { createLazyCowFile } from "./lazy-cow.mjs";

const requests = [];
const open = XMLHttpRequest.prototype.open;
const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

XMLHttpRequest.prototype.open = function trackedOpen(method, url, ...rest) {
  this.__proofRequest = { method, url: String(url), range: null };
  requests.push(this.__proofRequest);
  return open.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.setRequestHeader = function trackedHeader(name, value) {
  if (this.__proofRequest && String(name).toLowerCase() === "range") {
    this.__proofRequest.range = String(value);
  }
  return setRequestHeader.call(this, name, value);
};

let disk;
const lines = [];
const options = {
  noInitialRun: false,
  print(line) {
    lines.push(String(line));
  },
  printErr(line) {
    lines.push(`stderr: ${line}`);
  },
  preRun: [
    (module) => {
      disk = createLazyCowFile(module.FS, "/pack/disk.bin", new URL("./dist/disk.bin", self.location.href).href);
    },
  ],
};

try {
  await createProof(options);
  const rangeRequests = requests.filter((request) => request.range);
  const result = {
    passed: lines.includes("LAZY_COW_PASS"),
    lines,
    requests,
    rangeRequestCount: rangeRequests.length,
    requestedWholeFile: rangeRequests.some((request) => request.range === "bytes=0-4194303"),
    disk: disk?.snapshot(),
  };
  self.postMessage(result);
} catch (error) {
  self.postMessage({
    passed: false,
    lines,
    requests,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}

