// SPDX-License-Identifier: AGPL-3.0-only
/** Which addresses are the public internet, for everything that fetches an address someone else chose. */
import { BlockList, isIP } from 'node:net';

// One list per family: in a shared one, Node also holds an IPv4 address against ::ffff:0:0/96, which refuses them all.
const V4 = new BlockList();
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
] as const)
  V4.addSubnet(net, prefix, 'ipv4');

const V6 = new BlockList();
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 32], // NAT64, 64:ff9b::/96 and 64:ff9b:1::/48
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7],
  ['fe80::', 9], // link-local and the old site-local
  ['ff00::', 8],
] as const)
  V6.addSubnet(net, prefix, 'ipv6');

/**
 * True for addresses on the owner's own computer, network or tailnet, and anything else that isn't the public internet.
 * An IPv6 address that carries an IPv4 one is refused whatever it carries: no public site is reached that way.
 */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return V4.check(ip, 'ipv4');
  if (v === 6) return V6.check(ip, 'ipv6');
  return true;
}
