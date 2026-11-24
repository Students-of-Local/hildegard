// SPDX-License-Identifier: AGPL-3.0-only
/** Which addresses are the public internet, for everything that fetches an address someone else chose. */
import { BlockList, isIP } from 'node:net';

// One list per family: in a shared one, Node also holds an IPv4 address against ::ffff:0:0/96, which refuses them all.
const V4 = new BlockList();
const V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, and the tailnet
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 16],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  V4.addSubnet(net, prefix, 'ipv4');
  V6.addSubnet(`64:ff9b::${net}`, 96 + prefix, 'ipv6');
}
for (const [net, prefix] of [
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
] as const)
  V6.addSubnet(net, prefix, 'ipv6');

// The only IPv6 addresses that can be the public internet: global unicast, and NAT64, which is how a network without
// IPv4 reaches a public IPv4 site.
const GLOBAL6 = new BlockList();
GLOBAL6.addSubnet('2000::', 3, 'ipv6');
GLOBAL6.addSubnet('64:ff9b::', 96, 'ipv6');

/**
 * True for addresses on the owner's own computer, network or tailnet, and anything else that isn't the public internet.
 * A NAT64 address is as private as the IPv4 address it carries; any other IPv6 address that carries one is refused.
 */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return V4.check(ip, 'ipv4');
  if (v === 6) return !GLOBAL6.check(ip, 'ipv6') || V6.check(ip, 'ipv6');
  return true;
}
