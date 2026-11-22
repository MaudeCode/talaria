import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

describe('POST /api/render/diagram (TAL-2678)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())
  const render = async (source: string) => {
    const res = await s.get('/api/render/diagram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) })
    expect(res.status).toBe(200)
    return (await res.json()) as { svg?: string; error?: string }
  }

  it('renders a flowchart as SVG without its links or images', async () => {
    const answer = await render([
      'flowchart TD',
      '  A[Start] --> B[Load]',
      '  B --> C[Check]',
      '  C --> D[Done]',
      '  click A href "https://link.example/x"',
      '  E@{ img: "https://image.example/y.png", label: "E" }',
    ].join('\n'))
    expect(answer.error).toBeUndefined()
    const svg = answer.svg ?? ''
    expect(svg).toMatch(/^<svg[\s>]/)
    for (const label of ['Start', 'Load', 'Check', 'Done']) expect(svg).toContain(`>${label}<`)
    expect(svg).not.toContain('link.example')
    expect(svg).not.toContain('image.example')
  })

  it('answers an error for source it cannot parse', async () => {
    const answer = await render('this is not a diagram')
    expect(answer.svg).toBeUndefined()
    expect(answer.error).toMatch(/diagram/i)
  })
})
