/**
 * Archive extraction for `/api/upload/extract` and `/api/workspace/upload` (Python `extract_archive`). Zip and tar
 * (plain, gzip, bzip2, xz) members land in a fresh `<parent>/<stem>` directory through the anchored exclusive create,
 * so a slipped name or a symlinked component never writes outside it. Every decompressor stops once its output passes
 * the extracted-bytes cap, and partial output is removed on any failure.
 */
import { closeSync, lstatSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { basename, join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import Bunzip from 'seek-bzip'
import xzPkg from 'xz-decompress'
import { writeFully } from '../fs/atomic.js'
import { makeAnchoredDir, openAnchoredCreateFd, rmtreeAnchored, safeResolve } from './fs.js'
import { resolvePathLikePython } from './paths.js'
import { BadZipError, readZip } from './unzip.js'

const { XzReadableStream } = xzPkg

export const ARCHIVE_SUFFIXES = ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz'] as const
/** A tiny archive of millions of empty members slips under the byte cap but exhausts inodes. */
export const MAX_ARCHIVE_MEMBERS = 10_000
/**
 * A decompressed tar stream may exceed the file-byte cap only by its framing: each member costs a 512-byte header plus
 * under 512 bytes of padding, and twice the member cap leaves room for directory and extended headers.
 */
const TAR_FRAMING_BYTES = 2 * MAX_ARCHIVE_MEMBERS * 1024

/** Python `ValueError`: the archive was refused (format, slip, size, or member count). */
export class ArchiveRejected extends Error {}
/** Python `BadZipFile` / `TarError`: the archive could not be read. */
export class CorruptArchive extends Error {}

export interface Extraction { extracted: number; files: string[]; dest: string }

export function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase()
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

/** Python `PurePath.stem`: the name without its last suffix (`a.tar.gz` -> `a.tar`, `.zip` -> `.zip`). */
function pythonStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name
}

function lexists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function tooLarge(cap: number): ArchiveRejected {
  return new ArchiveRejected(`Extraction too large (> ${String(Math.floor(cap / (1024 * 1024)))} MB limit). Possible zip bomb.`)
}

/**
 * Extract `bytes` into a new directory named for the archive under `parent`. `root` is the trusted directory (the
 * workspace or the session inbox) that `parent` lives in; every directory and file is created by an anchored walk
 * from it. The member count, total size, and every member path are checked before anything is created, and a failed
 * write removes the partial directory. `files` are relative to `parent`.
 */
export async function extractArchive(bytes: Buffer, filename: string, root: string, parent: string, cap: number): Promise<Extraction> {
  const name = basename(filename)
  const isZip = name.toLowerCase().endsWith('.zip')
  if (!isZip && !isArchiveName(name)) throw new ArchiveRejected(`Unsupported archive format: ${filename}`)
  const stem = pythonStem(name)
  if (!stem || stem === '.' || stem === '..') throw new ArchiveRejected(`Invalid archive name: ${filename}`)
  const members = isZip ? zipMembers(bytes) : [...tarMembers(await decompressTar(bytes, cap + TAR_FRAMING_BYTES, cap))]
  if (members.length > MAX_ARCHIVE_MEMBERS) throw new ArchiveRejected(`Archive has too many files (> ${String(MAX_ARCHIVE_MEMBERS)}). Possible archive bomb.`)
  // Declared sizes are binding: a zip member cannot inflate past its own, and a tar member is a slice of the stream.
  if (members.reduce((sum, m) => sum + m.size, 0) > cap) throw tooLarge(cap)
  const parentResolved = resolvePathLikePython(parent)
  let dest = join(parentResolved, stem)
  for (let attempt = 0; lexists(dest); attempt += 1) {
    if (attempt >= 1000) throw new ArchiveRejected('Could not allocate a unique extraction directory')
    dest = join(parentResolved, `${stem}_${String(randomInt(1000)).padStart(3, '0')}`)
  }
  const slip = isZip ? 'Zip' : 'Tar'
  const plan = members.map((member) => {
    let target: string
    try { target = safeResolve(dest, member.name) } catch { throw new ArchiveRejected(`${slip}-slip blocked: ${member.name}`) }
    if (target === dest) throw new ArchiveRejected(`${slip}-slip blocked: ${member.name}`)
    return { target, read: member.read }
  })
  makeAnchoredDir(root, dest)
  try {
    for (const { target, read } of plan) {
      let data: Buffer
      try { data = read() } catch (error) { throw error instanceof BadZipError ? new CorruptArchive(error.message) : error }
      const fd = openAnchoredCreateFd(root, target)
      try { writeFully(fd, data) } finally { closeSync(fd) }
    }
  } catch (error) {
    try { rmtreeAnchored(root, dest) } catch { /* the directory is already gone */ }
    throw error
  }
  return { extracted: plan.length, files: plan.map(({ target }) => relative(parentResolved, target)), dest }
}

interface Member { name: string; size: number; read: () => Buffer }

function zipMembers(bytes: Buffer): Member[] {
  try {
    return readZip(bytes).filter((entry) => !entry.isDir)
  } catch (error) {
    throw error instanceof BadZipError ? new CorruptArchive(`File is not a zip file: ${error.message}`) : error
  }
}

/** The raw tar stream, decompressed by magic number like Python `tarfile.open(mode='r:*')`, never past `limit` bytes. */
async function decompressTar(bytes: Buffer, limit: number, cap: number): Promise<Buffer> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return gunzipSync(bytes, { maxOutputLength: limit })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge(cap)
      throw new CorruptArchive('Invalid gzip data')
    }
  }
  if (bytes.subarray(0, 3).toString('latin1') === 'BZh') {
    let out = Buffer.allocUnsafe(64 * 1024)
    let pos = 0
    const sink = {
      writeByte(byte: number): void {
        if (pos >= limit) throw tooLarge(cap)
        if (pos === out.length) {
          const grown = Buffer.allocUnsafe(Math.min(out.length * 2, limit))
          out.copy(grown)
          out = grown
        }
        out[pos++] = byte
      },
    }
    try {
      Bunzip.decode(bytes, sink, true)
    } catch (error) {
      if (error instanceof ArchiveRejected) throw error
      throw new CorruptArchive('Invalid bzip2 data')
    }
    return out.subarray(0, pos)
  }
  if (bytes.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) {
    const reader = new XzReadableStream(new Blob([bytes]).stream()).getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > limit) {
          await reader.cancel()
          throw tooLarge(cap)
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      if (error instanceof ArchiveRejected) throw error
      throw new CorruptArchive('Invalid xz data')
    }
    return Buffer.concat(chunks, total)
  }
  return bytes
}

const BLOCK = 512
const REGULAR_TYPES = new Set(['0', '\0', '7'])
/** Python `tarfile`: these member types carry no data blocks even when their size field is set. */
const DATALESS_TYPES = new Set(['1', '2', '3', '4', '5', '6'])

function cString(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const nul = field.indexOf(0)
  return (nul < 0 ? field : field.subarray(0, nul)).toString('utf8')
}

/** Python `tarfile.nti`: an octal field, or GNU base-256 when the high bit is set. */
function tarNumber(header: Buffer, start: number, length: number): number {
  const first = header[start] ?? 0
  if (first === 0o200) {
    let n = 0
    for (let i = start + 1; i < start + length; i += 1) n = n * 256 + (header[i] ?? 0)
    return n
  }
  if (first === 0o377) throw new CorruptArchive('Invalid tar header')
  const text = cString(header, start, length).trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw new CorruptArchive('Invalid tar header')
  return Number.parseInt(text, 8)
}

/** Python `tarfile.calc_chksums`: the stored checksum may be the unsigned or the signed byte sum. */
function checksumOk(header: Buffer): boolean {
  let unsigned = 256
  let signed = 256
  for (let i = 0; i < BLOCK; i += 1) {
    if (i >= 148 && i < 156) continue
    const byte = header[i] ?? 0
    unsigned += byte
    signed += byte > 127 ? byte - 256 : byte
  }
  const stored = tarNumber(header, 148, 8)
  return stored === unsigned || stored === signed
}

function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let pos = 0
  while (pos < data.length && data[pos] !== 0) {
    const space = data.indexOf(0x20, pos)
    const length = space < 0 ? Number.NaN : Number(data.subarray(pos, space).toString('latin1'))
    if (!Number.isInteger(length) || length <= space - pos || pos + length > data.length || data[pos + length - 1] !== 0x0a) throw new CorruptArchive('Invalid pax header')
    const record = data.subarray(space + 1, pos + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq < 0) throw new CorruptArchive('Invalid pax header')
    records.set(record.slice(0, eq), record.slice(eq + 1))
    pos += length
  }
  return records
}

/** A small ustar/pax/GNU reader: yields regular-file members only (links, devices, and directories are skipped). */
function* tarMembers(tar: Buffer): Generator<Member> {
  if (tar.length < BLOCK) throw new CorruptArchive('Invalid tar archive')
  let offset = 0
  let longName: string | null = null
  let pax = new Map<string, string>()
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) return
    if (!checksumOk(header)) throw new CorruptArchive(offset === 0 ? 'Invalid tar archive' : 'Invalid tar header')
    let name = cString(header, 0, 100)
    if (header.subarray(257, 263).toString('latin1') === 'ustar\0') {
      const prefix = cString(header, 345, 155)
      if (prefix) name = `${prefix}/${name}`
    }
    let size = tarNumber(header, 124, 12)
    let type = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + BLOCK
    const padded = (n: number): number => Math.ceil(n / BLOCK) * BLOCK
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (dataStart + size > tar.length) throw new CorruptArchive('Unexpected end of tar data')
      const data = tar.subarray(dataStart, dataStart + size)
      if (type === 'x') pax = paxRecords(data)
      else if (type === 'L') longName = cString(data, 0, data.length)
      offset = dataStart + padded(size)
      continue
    }
    if (longName !== null) name = longName
    const paxPath = pax.get('path')
    if (paxPath !== undefined) name = paxPath
    const paxSize = pax.get('size')
    if (paxSize !== undefined) {
      if (!/^\d+$/.test(paxSize)) throw new CorruptArchive('Invalid pax header')
      size = Number(paxSize)
    }
    longName = null
    pax = new Map()
    if (type === '\0' && name.endsWith('/')) type = '5'
    if (REGULAR_TYPES.has(type)) {
      if (dataStart + size > tar.length) throw new CorruptArchive('Unexpected end of tar data')
      const data = tar.subarray(dataStart, dataStart + size)
      yield { name, size, read: () => data }
    }
    offset = dataStart + (DATALESS_TYPES.has(type) ? 0 : padded(size))
  }
}
