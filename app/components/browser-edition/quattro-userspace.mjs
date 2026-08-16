const USERSPACE_URL = "/browser-edition/quattro-userspace.wasm";
export const QUATTRO_USERSPACE_SHA256 =
  "50b17a00d924150b56c18bc0ee614e32da498ec2e6666587b71fc84bf95b3c0f";

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertExports(exports) {
  if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error("userspace memory export is missing");
  if (exports.omarchy_userspace_abi?.() !== 1) throw new Error("unsupported userspace ABI");
  if (typeof exports.omarchy_userspace_alloc !== "function") throw new Error("userspace allocator is missing");
  if (typeof exports.omarchy_userspace_exec !== "function") throw new Error("userspace executor is missing");
}

export async function loadQuattroUserspace({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (typeof fetchImpl !== "function" || !cryptoImpl?.subtle) {
    throw new Error("secure browser Wasm APIs are unavailable");
  }
  const response = await fetchImpl(USERSPACE_URL, { cache: "force-cache" });
  if (!response.ok) throw new Error(`userspace fetch failed with HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = hex(await cryptoImpl.subtle.digest("SHA-256", bytes));
  if (digest !== QUATTRO_USERSPACE_SHA256) throw new Error("userspace SHA-256 mismatch");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  assertExports(instance.exports);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function allocate(value) {
    const encoded = encoder.encode(value);
    const pointer = instance.exports.omarchy_userspace_alloc(encoded.byteLength);
    new Uint8Array(instance.exports.memory.buffer, pointer, encoded.byteLength).set(encoded);
    return { pointer, length: encoded.byteLength };
  }

  return Object.freeze({
    digest,
    execute(command, context = {}) {
      const input = allocate(String(command ?? ""));
      const theme = allocate(String(context.theme ?? "tokyo-night"));
      const packed = instance.exports.omarchy_userspace_exec(
        input.pointer,
        input.length,
        theme.pointer,
        theme.length,
      );
      const pointer = Number(packed >> 32n);
      const length = Number(packed & 0xffff_ffffn);
      const payload = decoder.decode(
        new Uint8Array(instance.exports.memory.buffer, pointer, length),
      );
      const separator = payload.indexOf("\0");
      if (separator < 0) throw new Error("userspace returned a malformed payload");
      const effect = payload.slice(0, separator) || null;
      const output = payload.slice(separator + 1);
      return Object.freeze({
        effect,
        output: output ? Object.freeze(output.split("\n")) : Object.freeze([]),
      });
    },
  });
}
