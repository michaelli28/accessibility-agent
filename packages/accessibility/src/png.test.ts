import { describe, it, expect } from 'vitest'
import { deflateSync } from 'node:zlib'
import { decodePng, countChangedPixels, type RgbaImage } from './png.js'

// Test-side PNG encoder: one filter type per row, so every unfilter path is exercised.
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  return Buffer.concat([head, Buffer.from(data), Buffer.alloc(4)])
}

function encode(width: number, rows: number[][], channels: 3 | 4, filters: number[]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(rows.length, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  const lines = rows.map((row, r) => {
    const up = rows[r - 1] ?? row.map(() => 0)
    const filter = filters[r % filters.length]
    const out = row.map((x, i) => {
      const a = i >= channels ? row[i - channels] : 0
      const b = up[i]
      const c = i >= channels ? up[i - channels] : 0
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]
      return (x - predictor + 256) % 256
    })
    return Buffer.from([filter, ...out])
  })
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(lines))),
    chunk('IEND', new Uint8Array()),
  ])
}

const RGB_ROWS = [
  [10, 20, 30, 200, 100, 50, 0, 255, 128],
  [11, 22, 33, 199, 101, 52, 255, 0, 127],
  [250, 5, 60, 7, 7, 7, 90, 180, 45],
  [0, 0, 0, 255, 255, 255, 1, 2, 3],
  [128, 128, 128, 64, 32, 16, 8, 4, 2],
]

function rgba(rows: number[][], channels: 3 | 4): number[] {
  return rows.flatMap((row) =>
    channels === 4
      ? row
      : Array.from({ length: row.length / 3 }, (_, i) => [...row.slice(i * 3, i * 3 + 3), 255]).flat(),
  )
}

describe('decodePng', () => {
  it('decodes 8-bit RGB with every filter type (none, sub, up, average, paeth) to RGBA', () => {
    const image = decodePng(encode(3, RGB_ROWS, 3, [0, 1, 2, 3, 4]))

    expect(image.width).toBe(3)
    expect(image.height).toBe(5)
    expect([...image.rgba]).toEqual(rgba(RGB_ROWS, 3))
  })

  it('decodes 8-bit RGBA and IDAT data split over several chunks', () => {
    const rows = [
      [1, 2, 3, 4, 250, 240, 230, 0],
      [9, 8, 7, 6, 5, 4, 3, 2],
    ]
    const whole = encode(2, rows, 4, [4, 3])
    // Re-split the single IDAT payload into two chunks.
    const idatAt = whole.indexOf('IDAT') - 4
    const length = whole.readUInt32BE(idatAt)
    const payload = whole.subarray(idatAt + 8, idatAt + 8 + length)
    const split = Buffer.concat([
      whole.subarray(0, idatAt),
      chunk('IDAT', payload.subarray(0, 3)),
      chunk('IDAT', payload.subarray(3)),
      whole.subarray(idatAt + 12 + length),
    ])

    expect([...decodePng(split).rgba]).toEqual(rgba(rows, 4))
  })

  it('rejects a non-PNG buffer and unsupported formats', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/PNG/)
    const png = encode(1, [[1, 2, 3]], 3, [0])
    const gray = Buffer.from(png)
    gray[8 + 8 + 9] = 0
    expect(() => decodePng(gray)).toThrow(/unsupported/)
  })
})

describe('countChangedPixels', () => {
  const image = (pixels: number[]): RgbaImage => ({
    width: pixels.length / 4,
    height: 1,
    rgba: Uint8Array.from(pixels),
  })

  it('counts pixels whose largest channel difference exceeds the threshold', () => {
    const a = image([0, 0, 0, 255, 100, 100, 100, 255, 7, 7, 7, 255])
    const b = image([0, 0, 0, 255, 100, 140, 100, 255, 7, 7, 12, 255])

    expect(countChangedPixels(a, a, 10)).toBe(0)
    expect(countChangedPixels(a, b, 10)).toBe(1)
    expect(countChangedPixels(a, b, 4)).toBe(2)
  })

  it('throws when the images differ in size', () => {
    expect(() => countChangedPixels(image([0, 0, 0, 255]), image([0, 0, 0, 255, 0, 0, 0, 255]), 10)).toThrow(/size/)
  })
})
