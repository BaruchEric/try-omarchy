/* global addToLibrary, HEAP32, HEAPF64, Module, UTF8ToString, omarchyWorkerScreenDimension */
/* eslint-disable @typescript-eslint/no-unused-vars -- Emscripten library callback ABI fixes these arities. */

// SDL 2.24's Emscripten video bootstrap calls emscripten_get_screen_size().
// Emscripten 3.1.50 implements that import with the Window-only `screen`
// global. The production runtime deliberately instantiates SDL inside a
// dedicated Worker, where its transferred OffscreenCanvas is the only
// authoritative display surface.
addToLibrary({
  $omarchyWorkerScreenDimension: (axis, fallback) => {
    const canvas = Module["canvas"];
    const value = canvas && Number(canvas[axis]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  },

  emscripten_get_screen_size__deps: ["$omarchyWorkerScreenDimension"],
  emscripten_get_screen_size__proxy: "sync",
  emscripten_get_screen_size: (width, height) => {
    HEAP32[width >> 2] = omarchyWorkerScreenDimension("width", 1600);
    HEAP32[height >> 2] = omarchyWorkerScreenDimension("height", 900);
  },

  // SDL probes for external CSS by temporarily resizing #canvas to 1x1 and
  // reading its CSS box. An OffscreenCanvas has neither a DOM selector nor a
  // CSS box, so Emscripten's stock helpers fail and SDL turns an otherwise
  // valid 640x480 window into 0x0. Module.canvas is authoritative here and a
  // 1x1 CSS result means "no external CSS controls this surface."
  emscripten_set_canvas_element_size__proxy: "sync",
  emscripten_set_canvas_element_size: (target, width, height) => {
    const canvas = Module["canvas"];
    if (!canvas) return -4;
    canvas.width = width;
    canvas.height = height;
    return 0;
  },
  emscripten_get_element_css_size__proxy: "sync",
  emscripten_get_element_css_size: (target, width, height) => {
    if (typeof document === "undefined") {
      if (!Module["canvas"]) return -4;
      HEAPF64[width >> 3] = 1;
      HEAPF64[height >> 3] = 1;
      if (!Module["omarchyWorkerCanvasCssReported"]) {
        Module["omarchyWorkerCanvasCssReported"] = true;
        Module["printErr"](
          "OMARCHY_RUNTIME_DIAGNOSTIC worker-canvas-css-size width=1 height=1",
        );
      }
      return 0;
    }
    const canvas = Module["canvas"];
    if (!canvas || typeof canvas.getBoundingClientRect !== "function") return -4;
    const bounds = canvas.getBoundingClientRect();
    HEAPF64[width >> 3] = bounds.width;
    HEAPF64[height >> 3] = bounds.height;
    return 0;
  },

  // SDL registers browser pointer-lock and fullscreen listeners while it
  // creates its window. Emscripten 3.1.50's implementations dereference the
  // Window-only `document` global before checking whether their targets
  // exist. These optional DOM event paths are intentionally unsupported in
  // the outer Worker; keyboard and pointer input arrive through worker-input.
  emscripten_set_pointerlockchange_callback_on_thread__proxy: "sync",
  emscripten_set_pointerlockchange_callback_on_thread: (
    target, userData, useCapture, callbackfunc, targetThread,
  ) => -1,
  emscripten_set_fullscreenchange_callback_on_thread__proxy: "sync",
  emscripten_set_fullscreenchange_callback_on_thread: (
    target, userData, useCapture, callbackfunc, targetThread,
  ) => -1,

  // SDL core assigns the initial empty window title from inside
  // SDL_CreateWindow, before QEMU reaches its separately guarded caption
  // update. Preserve browser-window behavior but make this import a no-op in
  // the outer Worker.
  emscripten_set_window_title__proxy: "sync",
  emscripten_set_window_title: (title) => {
    if (typeof document !== "undefined") document.title = UTF8ToString(title);
  },
});
