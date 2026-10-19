import { isIP } from 'node:net';

// Which addresses the worker endpoint may be on, and which a worker may reach over plain http. One rule for both ends: this machine,
// or the Tailscale tunnel (WireGuard encrypts it). Nothing else, so a typo or a public address cannot put a token on an open network.

/** Eight 16-bit groups of an IPv6 address, or undefined. Zone ids and brackets are dropped. */
function groupsOf(address: string): number[] | undefined {
  const bare = address.replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 6) return undefined;
  // The URL parser writes every spelling the same way: lowercase hex, no embedded dotted tail.
  const normal = new URL(`http://[${bare}]`).hostname.replace(/^\[|\]$/g, '');
  const [head = '', tail] = normal.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array<string>(Math.max(fill, 0)).fill('0'), ...right].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((g) => Number.isInteger(g)) ? all : undefined;
}

function octetsOf(address: string): number[] | undefined {
  return isIP(address) === 4 ? address.split('.').map(Number) : undefined;
}

/** Is it "every interface": 0.0.0.0, ::, and their spellings (including ::ffff:0.0.0.0)? */
export function isWildcard(address: string): boolean {
  const v4 = octetsOf(address);
  if (v4) return v4.every((o) => o === 0);
  const g = groupsOf(address);
  if (!g) return false;
  return g.every((x) => x === 0) || (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && g[6] === 0 && g[7] === 0);
}

/**
 * 127.0.0.0/8, ::1, the Tailscale ranges 100.64.0.0/10 and fd7a:115c:a1e0::/48. An IPv4 address written as ::ffff:a.b.c.d is NOT
 * accepted, even for a good a.b.c.d: spell it as IPv4.
 */
export function isLoopbackOrTailnet(address: string): boolean {
  const v4 = octetsOf(address);
  if (v4) return v4[0] === 127 || (v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127);
  const g = groupsOf(address);
  if (!g) return false;
  const loopback = g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
  const tailnet = g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0;
  return loopback || tailnet;
}
