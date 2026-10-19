import { inflateSync } from 'node:zlib'

// Minimal PNG reader for the browser's own screenshots (8-bit RGB/RGBA, not interlaced). CRCs are
// not checked: the bytes come straight from the browser.

export type RgbaImage = { width: number; height: number; rgba: Uint8Array }

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
// IHDR colour type -> channels per pixel.
const CHANNELS = new Map([
  [2, 3],
  [6, 4],
])

export function decodePng(png: Uint8Array): RgbaImage {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG')
  let width = 0
  let height = 0
  let channels = 0
  const idat: Buffer[] = []
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('ascii', at + 4, at + 8)
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [depth, colorType, , , interlace] = data.subarray(8, 13)
      channels = CHANNELS.get(colorType) ?? 0
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colorType}, interlace ${interlace}`)
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }
  if (channels === 0) throw new Error('PNG has no IHDR chunk')
  const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels)
  return { width, height, rgba: channels === 4 ? raw : toRgba(raw) }
}

// Pixels whose largest channel difference (alpha included) is above threshold (0-255).
export function countChangedPixels(a: RgbaImage, b: RgbaImage, threshold: number): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`image size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  let changed = 0
  for (let i = 0; i < a.rgba.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(a.rgba[i + c] - b.rgba[i + c]) > threshold) {
        changed++
        break
      }
    }
  }
  return changed
}

// Reverses the per-scanline filters: none, sub, up, average, paeth.
function unfilter(data: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels
  if (data.length < height * (stride + 1)) throw new Error('PNG image data is truncated')
  const out = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels] : 0
      const b = y > 0 ? out[row - stride + x] : 0
      const c = x >= channels && y > 0 ? out[row - stride + x - channels] : 0
      out[row + x] = (data[src + x] + predict(filter, a, b, c)) & 0xff
    }
  }
  return out
}

function predict(filter: number, a: number, b: number, c: number): number {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return a
    case 2:
      return b
    case 3:
      return (a + b) >> 1
    case 4: {
      const p = a + b - c
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    default:
      throw new Error(`unknown PNG filter type ${filter}`)
  }
}

function toRgba(rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array((rgb.length / 3) * 4)
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i]
    out[j + 1] = rgb[i + 1]
    out[j + 2] = rgb[i + 2]
    out[j + 3] = 255
  }
  return out
}
