import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  loadQuattroUserspace,
  QUATTRO_USERSPACE_SHA256,
} from "../app/components/browser-edition/quattro-userspace.mjs";

const wasmUrl = new URL("../public/browser-edition/quattro-userspace.wasm", import.meta.url);

test("loads only the exact compiled Quattro userspace", async () => {
  const bytes = await readFile(wasmUrl);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), QUATTRO_USERSPACE_SHA256);
  const userspace = await loadQuattroUserspace({
    fetchImpl: async () => new Response(bytes),
    cryptoImpl: webcrypto,
  });
  assert.equal(userspace.digest, QUATTRO_USERSPACE_SHA256);
});

test("executes Browser Edition commands inside Wasm", async () => {
  const bytes = await readFile(wasmUrl);
  const userspace = await loadQuattroUserspace({
    fetchImpl: async () => new Response(bytes),
    cryptoImpl: webcrypto,
  });

  const fastfetch = userspace.execute("fastfetch", { theme: "gruvbox" });
  assert.match(fastfetch.output.join("\n"), /Omarchy Quattro Browser Edition/);
  assert.match(fastfetch.output.join("\n"), /Quattro Wasm userspace/);
  assert.match(fastfetch.output.join("\n"), /Theme: Gruvbox/);
  assert.equal(userspace.execute("omarchy-menu").effect, "menu");
  assert.equal(userspace.execute("open files").effect, "open:files");
  assert.equal(
    userspace.execute("omarchy-theme-set rose-pine").effect,
    "theme:rose-pine",
  );
});

test("rejects mutated userspace bytes before WebAssembly compilation", async () => {
  const bytes = new Uint8Array(await readFile(wasmUrl));
  bytes[bytes.length - 1] ^= 0xff;
  await assert.rejects(
    loadQuattroUserspace({
      fetchImpl: async () => new Response(bytes),
      cryptoImpl: webcrypto,
    }),
    /SHA-256 mismatch/,
  );
});
