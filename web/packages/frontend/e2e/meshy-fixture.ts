import { deflateSync } from 'node:zlib'

/** TAL-1514 fixtures: a tiny PNG and a textured, animated, self-contained GLB, built in memory. */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
function crc32(bytes: Buffer): number { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** An RGB checkerboard PNG. */
export function checkerPng(size = 64, a: [number, number, number] = [236, 112, 52], b: [number, number, number] = [40, 44, 52]): Buffer {
  const rows: Buffer[] = []
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x += 1) row.set(((x >> 3) + (y >> 3)) % 2 ? a : b, 1 + x * 3)
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

const f32 = (values: number[]) => Buffer.from(new Float32Array(values).buffer)
const pad4 = (b: Buffer, fill = 0) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b)

/** A textured cube with one looping rotation clip named "spin", everything in the GLB's own binary chunk. */
export function texturedAnimatedGlb(): Buffer {
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ]
  const pos: number[] = []; const nor: number[] = []; const uv: number[] = []; const idx: number[] = []
  faces.forEach(([n, u, v], face) => {
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      pos.push(...[0, 1, 2].map((i) => 0.5 * (n[i]! + su * u[i]! + sv * v[i]!)))
      nor.push(...n); uv.push((su + 1) / 2, 1 - (sv + 1) / 2)
    }
    const o = face * 4
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3)
  })
  const half = Math.SQRT1_2
  const parts = [f32(pos), f32(nor), f32(uv), pad4(Buffer.from(new Uint16Array(idx).buffer)), pad4(checkerPng()), f32([0, 1, 2]), f32([0, 0, 0, 1, 0, half, 0, half, 0, 1, 0, 0])]
  let offset = 0
  const views = parts.map((p) => { const view = { buffer: 0, byteOffset: offset, byteLength: p.length }; offset += p.length; return view })
  const bin = Buffer.concat(parts)
  const json = {
    asset: { version: '2.0', generator: 'talaria-e2e' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Robot' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }],
    textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9728, minFilter: 9728 }], images: [{ bufferView: 4, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 24, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 5, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] }, { bufferView: 6, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    bufferViews: views, buffers: [{ byteLength: bin.length }],
    animations: [{ name: 'spin', samplers: [{ input: 4, output: 5, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] }],
  }
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20)
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length
  const header = Buffer.alloc(12); header.write('glTF', 0, 'latin1'); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jh, jsonChunk, bh, bin])
}
