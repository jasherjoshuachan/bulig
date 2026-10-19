import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertBindable, GatewayConfigError, parseGatewayConfig, parseTokenMap } from '../src/config.ts';
import { tmp } from './support.ts';

const TOKEN = 'a-long-enough-token-0123';
const env = { T1: TOKEN, T2: 'another-long-enough-token-99' };
const workers = { mac: { tokenEnv: 'T1' } };

describe('where the endpoint may listen', () => {
  it('defaults to this machine only, on port 7431', () => {
    const c = parseGatewayConfig({ workers }, env);
    expect(c.listen).toEqual(['127.0.0.1']);
    expect(c.port).toBe(7431);
    expect(c.localSlots).toBe(2);
    expect(c.heartbeatMs).toBe(10_000);
    expect(c.heartbeatTimeoutMs).toBe(30_000);
    expect(c.claimWaitMs).toBe(25_000);
  });

  it.each(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '::0', '::ffff:0.0.0.0', '0000:0000:0000:0000:0000:0000:0000:0000'])('refuses to bind %s', (address) => {
    expect(() => parseGatewayConfig({ listen: [address], workers }, env)).toThrow(GatewayConfigError);
    expect(() => parseGatewayConfig({ listen: ['127.0.0.1', address], workers }, env)).toThrow(/every interface/);
  });

  it.each(['localhost', 'example.com', '', '1.2.3', '100.64.0.1/10'])('refuses %j: only IP addresses are accepted', (address) => {
    expect(() => assertBindable(address)).toThrow(GatewayConfigError);
  });

  it.each(['127.0.0.1', '127.5.5.5', '::1', '[::1]', '100.64.0.1', '100.101.102.103', '100.127.255.255', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12::7'])('accepts %s: this machine or the Tailscale tunnel', (address) => {
    expect(parseGatewayConfig({ listen: [address], workers }, env).listen).toHaveLength(1);
  });

  it.each([
    '203.0.113.5', '8.8.8.8', '192.168.1.10', '10.0.0.1', '172.16.0.1', '169.254.1.1', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1',
    '2001:db8::1', 'fe80::1', 'fd7a:115c:a1e1::1', 'fd7a:115c:a1df::1', 'fc00::1',
    '::ffff:203.0.113.5', '::ffff:127.0.0.1', '::ffff:100.64.0.1', '::ffff:cb00:7105',
  ])('refuses %s: it is not this machine or Tailscale, so a token could cross an open network', (address) => {
    expect(() => parseGatewayConfig({ listen: [address], workers }, env)).toThrow(/neither this machine nor the Tailscale tunnel/);
  });

  it('refuses a heartbeat timeout under twice the heartbeat, like the lease', () => {
    expect(() => parseGatewayConfig({ heartbeatMs: 10_000, heartbeatTimeoutMs: 15_000, workers }, env)).toThrow(/less than half/);
  });

  it('refuses keys it does not know', () => {
    expect(() => parseGatewayConfig({ lisen: ['127.0.0.1'], workers }, env)).toThrow(GatewayConfigError);
  });
});

describe('worker tokens', () => {
  it('come from the variable the config names, and the config never holds the token itself', () => {
    const c = parseGatewayConfig({ workers }, env);
    expect(c.workers).toEqual([{ id: 'mac', token: TOKEN, slots: 2, projects: undefined }]);
    expect(() => parseGatewayConfig({ workers: { mac: { tokenEnv: TOKEN } } }, env)).toThrow(/NAME of an environment variable/);
  });

  it('errors name the setting and never print a token', () => {
    const attempts: Record<string, unknown>[] = [
      { workers: { mac: { tokenEnv: 'UNSET_VAR' } } },
      { workers: { mac: { tokenEnv: 'SHORT' } } },
      { workers: { mac: { tokenEnv: 'T1' }, pi: { tokenEnv: 'T1' } } },
      { workers: { mac: {} } },
    ];
    for (const raw of attempts) {
      let message = '';
      try {
        parseGatewayConfig(raw, { ...env, SHORT: 'abc' });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain('abc');
    }
  });

  it('are refused when too short, shared by two workers, or given to the reserved id', () => {
    expect(() => parseGatewayConfig({ workers: { mac: { tokenEnv: 'S' } } }, { S: 'tiny' })).toThrow(/shorter than/);
    expect(() => parseGatewayConfig({ workers: { mac: { tokenEnv: 'T1' }, pi: { tokenEnv: 'T1' } } }, env)).toThrow(/share one token/);
    expect(() => parseGatewayConfig({ workers: { local: { tokenEnv: 'T1' } } }, env)).toThrow(/not "local"/);
    expect(() => parseGatewayConfig({ workers: { 'Bad Id': { tokenEnv: 'T1' } } }, env)).toThrow(GatewayConfigError);
  });

  describe('from files (systemd LoadCredential on the server)', () => {
    const credDir = () => {
      const d = tmp('bulig-cred-');
      mkdirSync(d, { recursive: true });
      return d;
    };

    it('a credential file with id=token lines is used, and wins over the environment', () => {
      const d = credDir();
      writeFileSync(join(d, 'worker-tokens'), `# tokens\nmac=file-token-0123456789abc\npi=pi-file-token-0123456789\n`);
      const c = parseGatewayConfig({ workers: { mac: { credential: 'worker-tokens', tokenEnv: 'T1' } } }, { ...env, CREDENTIALS_DIRECTORY: d });
      expect(c.workers[0]!.token).toBe('file-token-0123456789abc');
    });

    it('with no credential file the environment variable is used, as on the Mac', () => {
      const c = parseGatewayConfig({ workers: { mac: { credential: 'worker-tokens', tokenEnv: 'T1' } } }, env);
      expect(c.workers[0]!.token).toBe(TOKEN);
    });

    it('a token file holds one token and wins over the environment', () => {
      const d = credDir();
      const f = join(d, 'mac.token');
      writeFileSync(f, 'file-token-0123456789abc\n');
      chmodSync(f, 0o600);
      expect(parseGatewayConfig({ workers: { mac: { tokenFile: f, tokenEnv: 'T1' } } }, env).workers[0]!.token).toBe('file-token-0123456789abc');
    });

    it.each([0o644, 0o640, 0o660, 0o604, 0o620, 0o602])('a token file with mode %o is refused: any group or other permission', (mode) => {
      const d = credDir();
      const f = join(d, 'mac.token');
      writeFileSync(f, 'file-token-0123456789abc\n');
      chmodSync(f, mode);
      expect(() => parseGatewayConfig({ workers: { mac: { tokenFile: f } } }, env)).toThrow(/readable by its owner only/);
    });

    it.each([0o600, 0o400])('a token file with mode %o is accepted', (mode) => {
      const d = credDir();
      const f = join(d, 'mac.token');
      writeFileSync(f, 'file-token-0123456789abc\n');
      chmodSync(f, mode);
      expect(parseGatewayConfig({ workers: { mac: { tokenFile: f } } }, env).workers[0]!.token).toBe('file-token-0123456789abc');
    });

    it('a credential name cannot climb out of the credentials directory', () => {
      const d = credDir();
      writeFileSync(join(d, '..', 'stolen'), 'mac=stolen-token-0123456789abc\n');
      expect(() => parseGatewayConfig({ workers: { mac: { credential: '../stolen' } } }, { CREDENTIALS_DIRECTORY: d })).toThrow(/no token found/);
    });

    it('parseTokenMap reads id=token lines and skips comments', () => {
      expect([...parseTokenMap('# c\n\nmac=abc=def\n bad line\npi=xyz\n')]).toEqual([['mac', 'abc=def'], ['pi', 'xyz']]);
    });
  });
});
