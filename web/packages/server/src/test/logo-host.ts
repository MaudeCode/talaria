/** TAL-2199: a fake connector logo host. It owns `https://logos.example/`, answering one SVG there and 404 anywhere else. */
export const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#ea4335"/></svg>'
export const LOGO_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString('base64')}`
export const logoFetch: typeof fetch = (input) => Promise.resolve((input instanceof Request ? input.url : input.toString()).startsWith('https://logos.example/')
  ? new Response(LOGO_SVG, { headers: { 'content-type': 'image/svg+xml' } })
  : new Response('', { status: 404 }))
