import assert from "node:assert/strict";

assert.equal(typeof globalThis.gc, "function", "run this fixture with --expose-gc");

// (module (func (export "start") (param i32) (result i32) local.get 0))
const identityModule = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x09, 0x01, 0x05, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x20, 0x00, 0x0b,
]);

const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
const tableMirror = [];
const functionsInTableMap = new WeakMap();
let finalized = 0;
const registry = new FinalizationRegistry(() => {
  finalized += 1;
});
let instanceRef;
let functionRef;

(function installNestedModule() {
  const compiledModule = new WebAssembly.Module(identityModule);
  const instance = new WebAssembly.Instance(compiledModule);
  const exported = instance.exports.start;
  instanceRef = new WeakRef(instance);
  functionRef = new WeakRef(exported);
  registry.register(instance, "instance");
  table.set(0, exported);
  tableMirror[0] = table.get(0);
  functionsInTableMap.set(exported, 0);
}());

async function collect() {
  // WeakRef targets are kept alive until the end of the current job. Do not
  // dereference between GC turns or the test itself would extend the lifetime.
  for (let iteration = 0; iteration < 16; iteration += 1) {
    globalThis.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

await collect();
assert.ok(instanceRef.deref(), "the real table and mirror must retain the instance");
assert.ok(functionRef.deref(), "the real table and mirror must retain its exported function");
assert.equal(finalized, 0);

table.set(0, null);
await collect();
assert.ok(instanceRef.deref(), "the Emscripten mirror alone is a strong root");
assert.ok(functionRef.deref(), "the Emscripten mirror alone retains the exported function");
assert.equal(finalized, 0);

functionsInTableMap.delete(tableMirror[0]);
tableMirror[0] = null;
await collect();
assert.equal(instanceRef.deref(), undefined);
assert.equal(functionRef.deref(), undefined);
assert.equal(finalized, 1);

process.stdout.write(JSON.stringify({
  finalizationCount: finalized,
  tableEntry: table.get(0),
  mirrorEntry: tableMirror[0],
}));
