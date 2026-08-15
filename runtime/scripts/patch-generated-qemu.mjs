#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "qemu-system-x86_64");
const source = await readFile(path, "utf8");
const transforms = [
  {
    label: "Emscripten Browser.init pointer-lock branch",
    needle: 'var canvas=Module["canvas"];if(canvas){canvas.requestPointerLock=',
    replacement: 'var canvas=Module["canvas"];if(canvas&&typeof document!="undefined"){canvas.requestPointerLock=',
  },
  {
    label: "pthread Wasm URL bootstrap",
    needle: 'var wasmBinaryFile;if(Module["locateFile"]){',
    replacement: 'var wasmBinaryFile;if(ENVIRONMENT_IS_PTHREAD){wasmBinaryFile="qemu-system-x86_64.wasm"}else if(Module["locateFile"]){',
  },
];
const optionalTransforms = [
  {
    label: "existing OffscreenCanvas stable pthread identity",
    needle: 'var offscreenCanvases={};var moduleCanvasId=Module["canvas"]?Module["canvas"].id:"";',
    replacement: 'var offscreenCanvases={};if(Module["canvas"]instanceof OffscreenCanvas&&!Module["canvas"].id){Module["canvas"].id="canvas"}var moduleCanvasId=Module["canvas"]?Module["canvas"].id:"";',
  },
  {
    label: "existing OffscreenCanvas pthread re-transfer",
    needle: 'if(Module["canvas"]instanceof OffscreenCanvas&&name===Module["canvas"].id)Module["canvas"]=null}else if(!ENVIRONMENT_IS_PTHREAD){',
    replacement: 'if(Module["canvas"]instanceof OffscreenCanvas&&name===Module["canvas"].id)Module["canvas"]=null}else if(Module["canvas"]instanceof OffscreenCanvas&&name===Module["canvas"].id){if(!Module["canvas"].canvasSharedPtr){Module["canvas"].canvasSharedPtr=_malloc(12);HEAP32[Module["canvas"].canvasSharedPtr>>>2>>>0]=Module["canvas"].width;HEAP32[Module["canvas"].canvasSharedPtr+4>>>2>>>0]=Module["canvas"].height;HEAPU32[Module["canvas"].canvasSharedPtr+8>>>2>>>0]=0}offscreenCanvasInfo={offscreenCanvas:Module["canvas"],canvasSharedPtr:Module["canvas"].canvasSharedPtr,id:Module["canvas"].id};Module["canvas"]=null}else if(!ENVIRONMENT_IS_PTHREAD){',
  },
];
let patched = source;
let applied = 0;

for (const { label, needle, replacement } of transforms) {
  const firstNeedle = patched.indexOf(needle);
  const lastNeedle = patched.lastIndexOf(needle);
  const firstReplacement = patched.indexOf(replacement);
  const lastReplacement = patched.lastIndexOf(replacement);
  const hasOneNeedle = firstNeedle >= 0 && firstNeedle === lastNeedle;
  const hasOneReplacement = firstReplacement >= 0 && firstReplacement === lastReplacement;
  if (hasOneNeedle && firstReplacement < 0) {
    patched = patched.replace(needle, replacement);
    applied += 1;
  } else if (firstNeedle < 0 && hasOneReplacement) {
    // A cached link may already contain an earlier transform while a newly
    // added transform still needs to be applied. Accept that exact state.
  } else {
    throw new Error(`Expected exactly one unpatched or patched ${label} in ${path}.`);
  }
}

for (const { label, needle, replacement } of optionalTransforms) {
  const needleCount = patched.split(needle).length - 1;
  const replacementCount = patched.split(replacement).length - 1;
  if (needleCount === 1 && replacementCount === 0) {
    patched = patched.replace(needle, replacement);
    applied += 1;
  } else if (needleCount === 0 && replacementCount === 1) {
    // Already applied to a cached link.
  } else if (needleCount !== 0 || replacementCount !== 0) {
    throw new Error(`Expected at most one unpatched or patched ${label} in ${path}.`);
  }
}

const asyncifyStubUse = 'asyncifyStubs["';
const asyncifyStubDeclaration = "var asyncifyStubs={};";
const asyncifyStubUses = patched.split(asyncifyStubUse).length - 1;
const asyncifyStubDeclarations = patched.split(asyncifyStubDeclaration).length - 1;
if (asyncifyStubUses > 0) {
  if (asyncifyStubDeclarations === 0) {
    patched = `${asyncifyStubDeclaration}${patched}`;
    applied += 1;
  } else if (asyncifyStubDeclarations !== 1) {
    throw new Error(`Expected at most one Asyncify undefined-symbol stub map in ${path}.`);
  }
}

if (applied === 0) {
  throw new Error(`Generated QEMU module is already fully patched: ${path}.`);
}

await writeFile(path, patched, "utf8");
process.stdout.write(
  `Worker-safe Browser.init, pthread Wasm/canvas, and Asyncify stubs patched in ${path}\n`,
);
