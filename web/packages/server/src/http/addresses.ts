/**
 * Non-global address classification for outbound destinations that carry a
 * secret (Python `ipaddress.is_global` is False): every IANA special-purpose
 * range — loopback, private, link-local, CGNAT, benchmarking, documentation,
 * discard-only, the dummy prefix, NAT64 local-use translation, the `2001::/23`
 * special block, 6to4, the `3fff::/20` documentation block, SRv6 SIDs, multicast,
 * reserved, unspecified — plus IPv4-mapped and NAT64 forms of them. The
 * small global carve-outs inside those blocks stay refused: stricter is fine here.
 */
import { BlockList, isIP } from 'node:net'

const NON_GLOBAL = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NON_GLOBAL.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['100:0:0:1::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NON_GLOBAL.addSubnet(net, bits, 'ipv6')

/** The eight 16-bit groups of an IPv6 literal (dotted-quad tail accepted), or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null
  let text = address
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, tail] = text.split('::')
  const heads = head ? head.split(':').map((g) => parseInt(g, 16)) : []
  const tails = tail ? tail.split(':').map((g) => parseInt(g, 16)) : []
  const fill = text.includes('::') ? new Array<number>(8 - heads.length - tails.length).fill(0) : []
  const groups = [...heads, ...fill, ...tails]
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null
}

/** The IPv4 address an IPv6 literal embeds (IPv4-mapped `::ffff:0:0/96` or NAT64 `64:ff9b::/96`), in any spelling. */
function embeddedIPv4(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number]
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
  if (!mapped && !nat64) return null
  return `${String(g6 >> 8)}.${String(g6 & 0xff)}.${String(g7 >> 8)}.${String(g7 & 0xff)}`
}

/**
 * True for any address that is not globally routable; unparseable input is refused too. An IPv6 literal that embeds
 * an IPv4 address (mapped or NAT64, hex or dotted spelling) is classified by that IPv4 address as well.
 */
export function isNonGlobalAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').trim()
  const family = isIP(bare)
  if (!family) return true
  if (family === 4) return NON_GLOBAL.check(bare, 'ipv4')
  const groups = ipv6Groups(bare)
  if (!groups) return true
  const embedded = embeddedIPv4(groups)
  if (embedded && NON_GLOBAL.check(embedded, 'ipv4')) return true
  return NON_GLOBAL.check(bare, 'ipv6')
}

const PRIVATE_LAN = new BlockList()
for (const [net, bits] of [['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) PRIVATE_LAN.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE_LAN.addSubnet(net, bits, 'ipv6')
/** Tailscale's IPv6 tailnet prefix sits inside ULA `fc00::/7` but carries remote peers. */
const TAILSCALE_V6 = new BlockList()
TAILSCALE_V6.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')

/**
 * True for a loopback, RFC 1918, link-local or ULA client address (IPv4-mapped forms by their IPv4 address): the
 * auth-off local gate's notion of "on this LAN". Unlike `isNonGlobalAddress`, CGNAT `100.64.0.0/10` (Tailscale peers,
 * carrier-NAT neighbours) is remote, matching Python's `ipaddress.is_private`; Tailscale's IPv6 prefix is remote too.
 */
export function isPrivateLan(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').trim()
  const family = isIP(bare)
  if (family === 4) return PRIVATE_LAN.check(bare, 'ipv4')
  if (family !== 6) return false
  const groups = ipv6Groups(bare)
  const mapped = groups?.slice(0, 6).join() === '0,0,0,0,0,65535' ? embeddedIPv4(groups) : null
  if (mapped) return PRIVATE_LAN.check(mapped, 'ipv4')
  return PRIVATE_LAN.check(bare, 'ipv6') && !TAILSCALE_V6.check(bare, 'ipv6')
}
