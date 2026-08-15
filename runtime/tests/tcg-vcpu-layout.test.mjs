import assert from "node:assert/strict";
import test from "node:test";

const HOT_THRESHOLD = 750;
const WASM_HEADER = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

function makeTranslationBlock(slotCount) {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  const exportSize = slotCount * 4;
  const counterSizeOffset = 8 + exportSize;
  const counterSize = slotCount * 4;
  const temporaryBodySizeOffset = counterSizeOffset + 4 + counterSize;
  const temporaryBodySize = 16;
  const wasmSizeOffset = temporaryBodySizeOffset + 4 + temporaryBodySize;
  const wasmBegin = wasmSizeOffset + 4;

  view.setUint32(4, exportSize, true);
  view.setUint32(counterSizeOffset, counterSize, true);
  view.setUint32(temporaryBodySizeOffset, temporaryBodySize, true);
  view.setUint32(wasmSizeOffset, WASM_HEADER.length, true);
  bytes.set(WASM_HEADER, wasmBegin);
  view.setUint32(wasmBegin + WASM_HEADER.length, 0, true);
  return { bytes, view };
}

function exerciseInstanceLookup(block, slotCount, core) {
  const exportOffset = 8 + core * 4;
  const counterOffset = 12 + slotCount * 4 + core * 4;

  // This is the mismatch branch in get_instance_running_local(). An
  // out-of-range export slot aliases a nonzero layout field, so the branch
  // clears that field and makes this core's counter immediately hot.
  if (block.view.getUint32(exportOffset, true) !== 0) {
    block.view.setUint32(exportOffset, 0, true);
    block.view.setInt32(counterOffset, HOT_THRESHOLD, true);
  }
}

function parseNestedModule(block) {
  const { bytes, view } = block;
  const exportSize = view.getInt32(4, true);
  const exportBegin = 8;
  const counterSize = view.getInt32(exportBegin + exportSize, true);
  const counterBegin = exportBegin + exportSize + 4;
  const temporaryBodySize = view.getInt32(counterBegin + counterSize, true);
  const temporaryBodyBegin = counterBegin + counterSize + 4;
  const wasmSize = view.getInt32(temporaryBodyBegin + temporaryBodySize, true);
  const wasmBegin = temporaryBodyBegin + temporaryBodySize + 4;
  const wasmBytes = bytes.slice(wasmBegin, wasmBegin + wasmSize);
  return { exportSize, counterSize, temporaryBodySize, wasmSize, wasmBytes };
}

test("a third vCPU corrupts a two-slot TB into the observed empty nested module", () => {
  const block = makeTranslationBlock(2);

  exerciseInstanceLookup(block, 2, 2);
  const parsed = parseNestedModule(block);

  assert.deepEqual({
    exportSize: parsed.exportSize,
    counterSize: parsed.counterSize,
    temporaryBodySize: parsed.temporaryBodySize,
    wasmSize: parsed.wasmSize,
    byteLength: parsed.wasmBytes.byteLength,
  }, {
    exportSize: 8,
    counterSize: 0,
    temporaryBodySize: 0,
    wasmSize: 0,
    byteLength: 0,
  });
  assert.throws(() => new WebAssembly.Module(parsed.wasmBytes), WebAssembly.CompileError);
});

test("guest-vCPU-sized TB vectors keep four cores out of layout metadata", () => {
  const browserCores = 2;
  const guestVcpus = 4;
  const slotCount = Math.max(browserCores, guestVcpus);

  for (let core = 0; core < guestVcpus; core += 1) {
    const block = makeTranslationBlock(slotCount);
    exerciseInstanceLookup(block, slotCount, core);
    const parsed = parseNestedModule(block);

    assert.equal(parsed.exportSize, 16);
    assert.equal(parsed.counterSize, 16);
    assert.equal(parsed.wasmSize, WASM_HEADER.length);
    assert.deepEqual(parsed.wasmBytes, WASM_HEADER);
    assert.doesNotThrow(() => new WebAssembly.Module(parsed.wasmBytes));
  }
});
