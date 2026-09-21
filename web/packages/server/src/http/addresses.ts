/**
 * Non-global address classification for outbound destinations that carry a
 * secret (Python `ipaddress.is_global` is False): every IANA special-purpose
 * range — loopback, private, link-local, CGNAT, benchmarking, documentation,
 * discard-only, NAT64 local-use translation, the `2001::/23` special block,
 * 6to4, multicast, reserved, unspecified — plus IPv4-mapped forms of them. The
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
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) NON_GLOBAL.addSubnet(net, bits, 'ipv6')

/** True for any address that is not globally routable; unparseable input is refused too. */
export function isNonGlobalAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').trim()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare)?.[1]
  if (mapped) return isNonGlobalAddress(mapped)
  const family = isIP(bare)
  if (!family) return true
  return NON_GLOBAL.check(bare, family === 4 ? 'ipv4' : 'ipv6')
}
