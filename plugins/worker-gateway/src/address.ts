import { isIP } from 'node:net';

// Which addresses the worker endpoint may be on, and which a worker may reach over plain http. One rule for both ends: this machine,
// or the Tailscale tunnel (WireGuard encrypts it). Nothing else, so a typo or a public address cannot put a token on an open network.

/**
 * The one non-loopback address that counts as this machine: the deploy kit puts it on lo for a worker that runs in a network namespace of its
 * own (deploy/systemd/bulig-loopback.service). There 127.x is the namespace's own loopback, so the worker reaches the kernel at this address,
 * through pasta, without leaving the machine. It is in 198.18.0.0/15, the range set aside for benchmark tests (RFC 2544), which no real host
 * has. Only this exact address is accepted, not the range.
 */
export const NETNS_GATEWAY = '198.18.74.1';

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
 * 127.0.0.0/8, ::1, the worker namespace's gateway address 198.18.74.1 (NETNS_GATEWAY), the Tailscale ranges 100.64.0.0/10 and
 * fd7a:115c:a1e0::/48. An IPv4 address written as ::ffff:a.b.c.d is NOT accepted, even for a good a.b.c.d: spell it as IPv4.
 */
export function isLoopbackOrTailnet(address: string): boolean {
  const v4 = octetsOf(address);
  if (v4) return v4[0] === 127 || v4.join('.') === NETNS_GATEWAY || (v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127);
  const g = groupsOf(address);
  if (!g) return false;
  const loopback = g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
  const tailnet = g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0;
  return loopback || tailnet;
}

/**
 * May a connection from this peer address reach the gateway at all? The same rule as for the listen address, applied to the connection's
 * SOURCE, before any request is read (and so before the token is checked). A worker on this machine connects from a loopback address or, in
 * its own network namespace through pasta, from 198.18.74.1 (pasta does not bind its outbound sockets, so the host picks the local address);
 * a Mac worker connects from its Tailscale address. A machine on the same network segment that sends to 198.18.74.1 connects from its own
 * address, and is refused here. A forged source in the allowed set cannot finish the TCP handshake: the replies go to lo or the tunnel, not
 * to the forger, and Linux drops a packet that arrives from outside with a loopback or local source (martian). An IPv4 address that the
 * socket reports as ::ffff:a.b.c.d is judged as a.b.c.d.
 */
export function isAllowedPeer(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(remoteAddress);
  return isLoopbackOrTailnet(mapped ? mapped[1]! : remoteAddress);
}
