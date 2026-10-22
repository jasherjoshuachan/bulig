import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { gatewayServer, isAllowedPeer } from '../src/index.ts';

// The gateway refuses a connection by its SOURCE address before it reads a request (so before the token). A worker on this machine comes
// from loopback, or from 198.18.74.1 through pasta (its own network namespace); the Mac worker from Tailscale. Anyone else is refused.
describe('which peers may connect to the gateway', () => {
  it.each(['127.0.0.1', '127.74.3.1', '::1', '198.18.74.1', '::ffff:127.74.3.1', '::ffff:198.18.74.1', '100.101.102.103', 'fd7a:115c:a1e0::5'])('accepts %s', (a) => { // scan-forbidden: allow-addresses (a Tailscale test address)
    expect(isAllowedPeer(a)).toBe(true);
  });

  it.each(['203.0.113.5', '192.168.1.10', '10.0.0.7', '172.17.0.2', '198.18.74.2', '198.19.0.1', '::ffff:203.0.113.5', '2001:db8::1', 'fe80::1', '', undefined])('refuses %s', (a) => { // scan-forbidden: allow-addresses (refusal boundaries)
    expect(isAllowedPeer(a)).toBe(false);
  });

  it('closes a connection from a refused source before any request is handled, and says so', () => {
    const warned: string[] = [];
    let handled = 0;
    const server = gatewayServer(() => { handled += 1; }, { warn: (m) => warned.push(m) });
    const from = (remoteAddress: string) => {
      const sock = Object.assign(new EventEmitter(), { remoteAddress, destroyed: false, destroy() { this.destroyed = true; } });
      // (only our listener: node's own connection handler would start parsing HTTP on the fake socket)
      for (const l of server.listeners('connection').filter((f) => f.name !== 'connectionListener')) (l as (s: Socket) => void)(sock as unknown as Socket);
      return sock;
    };
    const neighbour = from('203.0.113.5'); // scan-forbidden: allow-addresses (a neighbour on the segment)
    expect(neighbour.destroyed).toBe(true);
    expect(warned).toEqual(['worker-gateway: refused a connection from 203.0.113.5: not this machine or the Tailscale tunnel']); // scan-forbidden: allow-addresses (a neighbour on the segment)
    expect(from('198.18.74.1').destroyed).toBe(false);
    expect(handled).toBe(0);
  });

  it('serves a request from loopback as before', async () => {
    const server = gatewayServer((_req, res) => { res.end('ok'); }, { warn: () => {} });
    await new Promise<void>((r) => server.listen({ host: '127.0.0.1', port: 0 }, () => r()));
    const { port } = server.address() as AddressInfo;
    const body = await new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/' }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); }).on('error', reject).end();
    });
    await new Promise<void>((r) => server.close(() => r()));
    expect(body).toBe('ok');
  });

  // (as text: the plugin's own servers are private) every server the plugin makes is a gatewayServer, so none skips the source check
  it('the plugin makes its servers with gatewayServer only', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src.match(/createServer\(/g)).toHaveLength(1);
    expect(src).toMatch(/const server = createServer\(handler\);\n  server\.on\('connection'/);
    expect(src).toMatch(/servers = cfg\.listen\.map\(\(\) =>\n\s+gatewayServer\(/);
  });
});
