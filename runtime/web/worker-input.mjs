export class WorkerInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerInputError";
  }
}

const keyEntries = [
  ["Enter", 40], ["Escape", 41], ["Backspace", 42], ["Tab", 43], ["Space", 44],
  ["Minus", 45], ["Equal", 46], ["BracketLeft", 47], ["BracketRight", 48],
  ["Backslash", 49], ["IntlHash", 50], ["Semicolon", 51], ["Quote", 52],
  ["Backquote", 53], ["Comma", 54], ["Period", 55], ["Slash", 56], ["CapsLock", 57],
  ["PrintScreen", 70], ["ScrollLock", 71], ["Pause", 72], ["Insert", 73], ["Home", 74],
  ["PageUp", 75], ["Delete", 76], ["End", 77], ["PageDown", 78], ["ArrowRight", 79],
  ["ArrowLeft", 80], ["ArrowDown", 81], ["ArrowUp", 82], ["NumLock", 83],
  ["NumpadDivide", 84], ["NumpadMultiply", 85], ["NumpadSubtract", 86], ["NumpadAdd", 87],
  ["NumpadEnter", 88], ["Numpad1", 89], ["Numpad2", 90], ["Numpad3", 91],
  ["Numpad4", 92], ["Numpad5", 93], ["Numpad6", 94], ["Numpad7", 95],
  ["Numpad8", 96], ["Numpad9", 97], ["Numpad0", 98], ["NumpadDecimal", 99],
  ["IntlBackslash", 100], ["ContextMenu", 101], ["NumpadEqual", 103],
  ["ControlLeft", 224], ["ShiftLeft", 225], ["AltLeft", 226], ["MetaLeft", 227],
  ["ControlRight", 228], ["ShiftRight", 229], ["AltRight", 230], ["MetaRight", 231],
];
for (let index = 0; index < 26; index += 1) {
  keyEntries.push([`Key${String.fromCharCode(65 + index)}`, 4 + index]);
}
for (let index = 1; index <= 9; index += 1) keyEntries.push([`Digit${index}`, 29 + index]);
keyEntries.push(["Digit0", 39]);
for (let index = 1; index <= 12; index += 1) keyEntries.push([`F${index}`, 57 + index]);
for (let index = 13; index <= 24; index += 1) keyEntries.push([`F${index}`, 91 + index]);

export const KEY_CODE_TO_SDL_SCANCODE = Object.freeze(Object.fromEntries(keyEntries));

function failInput(message) {
  throw new WorkerInputError(message);
}

function browserButtonsToSdl(buttons) {
  return (buttons & 1) | ((buttons & 4) >> 1) | ((buttons & 2) << 1) | (buttons & 24);
}

export function sanitizeWorkerInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failInput("Input event must be an object.");
  }
  if (value.kind === "key") {
    const scancode = KEY_CODE_TO_SDL_SCANCODE[value.code];
    if (!Number.isInteger(scancode) || typeof value.down !== "boolean") {
      failInput("Keyboard input requires an allowed physical code and boolean down state.");
    }
    return Object.freeze({ kind: "key", scancode, down: value.down });
  }
  if (value.kind === "pointer") {
    if (!Number.isFinite(value.x) || value.x < 0 || value.x > 1 ||
        !Number.isFinite(value.y) || value.y < 0 || value.y > 1 ||
        !Number.isInteger(value.buttons) || value.buttons < 0 || value.buttons > 31) {
      failInput("Pointer input requires normalized x/y coordinates and a five-bit buttons mask.");
    }
    return Object.freeze({
      kind: "pointer",
      x: Math.round(value.x * 32767),
      y: Math.round(value.y * 32767),
      buttons: browserButtonsToSdl(value.buttons),
    });
  }
  if (value.kind === "wheel") {
    if (!Number.isFinite(value.deltaX) || !Number.isFinite(value.deltaY) ||
        (value.deltaX === 0 && value.deltaY === 0)) {
      failInput("Wheel input requires a non-zero finite delta.");
    }
    return Object.freeze({
      kind: "wheel",
      x: value.deltaX === 0 ? 0 : -Math.sign(value.deltaX),
      y: value.deltaY === 0 ? 0 : -Math.sign(value.deltaY),
    });
  }
  failInput(`Unsupported input kind: ${String(value.kind)}.`);
}

export function dispatchSanitizedWorkerInputWithReceipt(
  instance,
  event,
  receiptHandle = 0,
) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    failInput("Sanitized input event must be an object.");
  }
  if (!Number.isSafeInteger(receiptHandle) || receiptHandle < 0 ||
      receiptHandle > 0x7fffffff) {
    failInput("Native input receipt handle is invalid.");
  }
  const calls = {
    key: ["_omarchy_input_key", [event.scancode, event.down ? 1 : 0, receiptHandle]],
    pointer: ["_omarchy_input_pointer", [event.x, event.y, event.buttons, receiptHandle]],
    wheel: ["_omarchy_input_wheel", [event.x, event.y, receiptHandle]],
  };
  const call = calls[event.kind];
  if (!call) failInput(`Unsupported sanitized input kind: ${String(event.kind)}.`);
  const [exportName, arguments_] = call;
  const exported = instance?.[exportName];
  if (typeof exported !== "function") failInput(`QEMU module is missing ${exportName}.`);
  const result = exported(...arguments_);
  if (result !== 0) failInput(`${exportName} rejected the input event with status ${result}.`);
  return event;
}

export function dispatchSanitizedWorkerInput(instance, event) {
  return dispatchSanitizedWorkerInputWithReceipt(instance, event, 0);
}

export function dispatchWorkerInput(instance, value) {
  return dispatchSanitizedWorkerInput(instance, sanitizeWorkerInput(value));
}
