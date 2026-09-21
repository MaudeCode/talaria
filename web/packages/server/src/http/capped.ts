/** Read at most `cap` bytes of a fetch response body, cancelling the upstream stream past it (`null`). */
export async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    const value: Uint8Array = chunk.value
    total += value.byteLength
    if (total > cap) { await reader.cancel(); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
