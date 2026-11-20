import { createServer, type IncomingMessage } from 'node:http'
import { expect, test } from './fixtures'

// TAL-2599: the Web server closes a keep-alive connection idle for 30 s. A routed fetch that reused a pooled socket as
// it closed failed the test with `route.fetch: socket hang up`.
test('a routed fetch never reuses a connection the server may already have closed', async ({ page }) => {
  // Drops any second request on a connection, as a server does whose idle close crosses the worker's next request.
  const served = new WeakSet<IncomingMessage['socket']>()
  const peer = createServer((request, response) => {
    if (!/^\/(first|second)$/.test(request.url ?? '')) return void response.writeHead(404).end()
    if (served.has(request.socket)) return void request.socket.destroy()
    served.add(request.socket)
    response.writeHead(200, { 'content-type': 'text/plain' }).end(request.url!.slice(1))
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const { port } = peer.address() as { port: number }
  try {
    await page.route(`http://127.0.0.1:${port}/**`, async (route) => route.fulfill({ response: await route.fetch() }))
    for (const path of ['first', 'second']) {
      await page.goto(`http://127.0.0.1:${port}/${path}`)
      await expect(page.locator('body')).toHaveText(path)
    }
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    peer.closeAllConnections()
    await new Promise<void>((resolve) => peer.close(() => resolve()))
  }
})
