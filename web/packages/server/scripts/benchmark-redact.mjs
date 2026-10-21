// Build both revisions, then pass their dist/redact.js paths. No timing threshold is enforced.
// node scripts/benchmark-redact.mjs /path/to/baseline/dist/redact.js ./dist/redact.js
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [baselinePath, candidatePath] = process.argv.slice(2)
assert(baselinePath && candidatePath, 'Expected baseline and candidate built redact.js paths')
const variants = await Promise.all([baselinePath, candidatePath].map(async (path) => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Caller supplies built module paths outside this project.
  const module = /** @type {{ redactSensitive: (text: string) => string }} */ (await import(pathToFileURL(resolve(path)).href))
  assert.equal(typeof module.redactSensitive, 'function')
  return module.redactSensitive
}))
/** @param {number[]} values */
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return ((sorted[Math.floor((sorted.length - 1) / 2)] ?? NaN) + (sorted[Math.floor(sorted.length / 2)] ?? NaN)) / 2
}

for (const bytes of [64 * 1024, 256 * 1024]) {
  const text = `https://example.test/${'A'.repeat(bytes)}`.slice(0, bytes)
  for (const redact of variants) {
    for (let warmup = 0; warmup < 3; warmup++) assert.equal(redact(text), text)
  }
  const pairs = []
  for (let pair = 0; pair < 12; pair++) {
    const costs = []
    for (const index of pair % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now()
      const output = variants[index](text)
      costs[index] = performance.now() - start
      assert.equal(output, text)
    }
    pairs.push({ baselineMs: costs[0], candidateMs: costs[1], speedup: costs[0] / costs[1] })
  }
  console.log(JSON.stringify({
    workload: 'synthetic URL with one long uppercase run and no equals; function cost only',
    node: process.version,
    bytes,
    pairs,
    medianBaselineMs: median(pairs.map((pair) => pair.baselineMs)),
    medianCandidateMs: median(pairs.map((pair) => pair.candidateMs)),
    medianPairedSpeedup: median(pairs.map((pair) => pair.speedup)),
    minPairedSpeedup: Math.min(...pairs.map((pair) => pair.speedup)),
    maxPairedSpeedup: Math.max(...pairs.map((pair) => pair.speedup)),
  }))
}
