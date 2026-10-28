import { describe, expect, it } from 'vitest'
import { parseMultipart } from './upload.js'

const boundary = 'AaB03x'
const contentType = `multipart/form-data; boundary=${boundary}`
const header = 'Content-Disposition: form-data; name="file"; filename="data.bin"'

describe('parseMultipart', () => {
  for (const newline of ['\r\n', '\n']) {
    it.each([
      Buffer.from('prefix--AaB03xmiddle-suffix'),
      Buffer.from('line\n--AaB03x-not-a-delimiter\n--AaB03x--suffix'),
      Buffer.from('--AaB03x-suffix\r\nstarts inside the payload'),
      Buffer.from([0, 255, 13, 10, 128, 0]),
      Buffer.from('no final newline'),
      Buffer.from('final LF\n'),
      Buffer.from('final CRLF\r\n'),
      Buffer.from('final CR\r'),
      Buffer.from('embedded\r\n\r\nblank line'),
      Buffer.from('\n\n'),
      Buffer.alloc(0),
    ])(`preserves payload bytes with ${JSON.stringify(newline)} framing: %j`, (body) => {
      const raw = Buffer.concat([
        Buffer.from(`--${boundary}${newline}${header}${newline}${newline}`),
        body, Buffer.from(`${newline}--${boundary}--${newline}`),
      ])
      expect(parseMultipart(raw, contentType).files.file?.body).toEqual(body)
    })
  }

  it('keeps fields, repeated file order and the last file by field name', () => {
    const raw = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="session_id"\r\n\r\nsession\r\n--${boundary}\r\n${header}\r\n\r\none\r\n--${boundary}\r\n${header}\r\n\r\ntwo\r\n--${boundary}--`)
    const result = parseMultipart(raw, contentType)
    expect(result.fields).toEqual({ session_id: 'session' })
    expect(result.parts.map((part) => part.body.toString())).toEqual(['one', 'two'])
    expect(result.files.file).toEqual(result.parts[1])
  })

  it('reads a quoted boundary with internal spaces and ignores other quoted parameters', () => {
    const raw = Buffer.from('--a b:c\r\n' + header + '\r\n\r\nbytes\r\n--a b:c--\r\n')
    expect(parseMultipart(raw, 'multipart/form-data; note=";boundary=wrong"; BOUNDARY="a b:c"').files.file?.body.toString()).toBe('bytes')
  })

  it('accepts preamble, epilogue and delimiter transport padding', () => {
    const raw = Buffer.from(`preamble\r\n--${boundary} \t\r\n${header}\r\n\r\nbytes\r\n--${boundary}-- \t\r\nepilogue`)
    expect(parseMultipart(raw, contentType).files.file?.body.toString()).toBe('bytes')
  })

  it.each(['', `\r\n--${boundary}`, `\r\n--${boundary}-\r\n`, `\r\n--${boundary}--suffix\r\n`, `--${boundary}--\r\n`, `\r\n--${boundary}--\r`])('refuses incomplete closing framing: %j', (ending) => {
    const raw = Buffer.from(`--${boundary}\r\n${header}\r\n\r\nbytes${ending}`)
    expect(() => parseMultipart(raw, contentType)).toThrow(/multipart/i)
  })

  it('refuses a later part without a header separator instead of returning an earlier file', () => {
    const raw = Buffer.from(`--${boundary}\r\n${header}\r\n\r\none\r\n--${boundary}\r\n${header}\r\n--${boundary}--\r\n`)
    expect(() => parseMultipart(raw, contentType)).toThrow(/multipart/i)
  })

  it.each(['', '""', '"trailing "', '"bad@boundary"', 'x'.repeat(71)])('refuses an invalid boundary parameter: %j', (value) => {
    expect(() => parseMultipart(Buffer.from('--x--'), `multipart/form-data; boundary=${value}`)).toThrow(/boundary/i)
  })
})
