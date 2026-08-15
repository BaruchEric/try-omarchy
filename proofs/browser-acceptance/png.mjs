import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_DOMINANT_COLOR_FRACTION = 0.95;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function inspectScreenshotPng(body, expectedWidth = 1600, expectedHeight = 900) {
  if (!Buffer.isBuffer(body) || body.byteLength < 45 || !body.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("Browser screenshot is not a complete PNG.");
  }
  let offset = 8;
  let ihdr = null;
  const idat = [];
  let ended = false;
  while (offset < body.byteLength) {
    if (offset + 12 > body.byteLength) throw new Error("Browser screenshot has a truncated PNG chunk.");
    const length = body.readUInt32BE(offset);
    const type = body.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > body.byteLength) throw new Error("Browser screenshot has a truncated PNG payload.");
    const expectedCrc = body.readUInt32BE(crcOffset);
    const actualCrc = crc32(body.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error(`Browser screenshot PNG ${type} CRC is invalid.`);
    const data = body.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (ihdr || length !== 13) throw new Error("Browser screenshot PNG has an invalid IHDR.");
      ihdr = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      if (length !== 0) throw new Error("Browser screenshot PNG has an invalid IEND.");
      ended = true;
      offset = crcOffset + 4;
      break;
    }
    offset = crcOffset + 4;
  }
  if (!ihdr || !ended || offset !== body.byteLength || idat.length === 0) {
    throw new Error("Browser screenshot PNG is structurally incomplete.");
  }

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`Browser screenshot is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}.`);
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0) {
    throw new Error("Browser screenshot must be a non-interlaced 8-bit RGB or RGBA PNG.");
  }

  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.byteLength !== (stride + 1) * height) {
    throw new Error("Browser screenshot PNG has an unexpected decoded byte length.");
  }
  const decoded = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (stride + 1);
    const targetOffset = y * stride;
    const filter = inflated[sourceOffset];
    if (filter > 4) throw new Error(`Browser screenshot PNG uses unknown filter ${filter}.`);
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + 1 + x];
      const left = x >= channels ? decoded[targetOffset + x - channels] : 0;
      const above = y > 0 ? decoded[targetOffset - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels
        ? decoded[targetOffset - stride + x - channels]
        : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      decoded[targetOffset + x] = (raw + predictor) & 255;
    }
  }

  let nonBlackPixels = 0;
  const colors = new Set();
  const colorKeys = new Uint32Array(width * height);
  let pixelIndex = 0;
  for (let offset_ = 0; offset_ < decoded.byteLength; offset_ += channels) {
    const red = decoded[offset_];
    const green = decoded[offset_ + 1];
    const blue = decoded[offset_ + 2];
    const color = (red << 16) | (green << 8) | blue;
    if (red !== 0 || green !== 0 || blue !== 0) nonBlackPixels += 1;
    if (colors.size <= 256) colors.add(color);
    colorKeys[pixelIndex] = color;
    pixelIndex += 1;
  }
  if (nonBlackPixels < width * height * 0.01 || colors.size < 16) {
    throw new Error("Browser screenshot is blank or does not contain a credible rendered desktop.");
  }
  colorKeys.sort();
  let dominantColorPixels = 1;
  let dominantColor = colorKeys[0];
  let runPixels = 1;
  for (let index = 1; index < colorKeys.length; index += 1) {
    if (colorKeys[index] === colorKeys[index - 1]) {
      runPixels += 1;
      if (runPixels > dominantColorPixels) {
        dominantColorPixels = runPixels;
        dominantColor = colorKeys[index];
      }
    } else {
      runPixels = 1;
    }
  }
  const dominantColorFraction = dominantColorPixels / (width * height);
  const dominantColorRgb = `#${dominantColor.toString(16).padStart(6, "0")}`;
  if (dominantColorFraction > MAX_DOMINANT_COLOR_FRACTION) {
    throw new Error(
      `Browser screenshot is visually degenerate: RGB ${dominantColorRgb} occupies ${(dominantColorFraction * 100).toFixed(3)}% of pixels.`,
    );
  }
  return Object.freeze({
    valid: true,
    width,
    height,
    bitDepth,
    colorType,
    nonBlackPixels,
    nonBlackFraction: nonBlackPixels / (width * height),
    observedColorsAtLeast: Math.min(colors.size, 256),
    dominantColorRgb,
    dominantColorPixels,
    dominantColorFraction,
  });
}
