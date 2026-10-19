import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeEnv, DENY_READ, readCredential, sandboxSettings } from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const credDir = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'bulig-cred-'));
  dirs.push(d);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(d, name), value);
    chmodSync(join(d, name), 0o400);
  }
  return d;
};

describe('readCredential (systemd LoadCredential)', () => {
  it('reads a file from $CREDENTIALS_DIRECTORY and drops the trailing newline', () => {
    const d = credDir({ 'pg-url': 'postgres://u:p@127.0.0.1/db\n' });
    expect(readCredential('pg-url', { CREDENTIALS_DIRECTORY: d })).toBe('postgres://u:p@127.0.0.1/db');
  });

  it('is undefined with no directory, no file, an empty file, a link, or a name that is not a plain file name', () => {
    const d = credDir({ empty: '\n' });
    const outside = mkdtempSync(join(tmpdir(), 'bulig-out-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(join(outside, 'secret'), join(d, 'linked'));
    mkdirSync(join(d, 'subdir'));
    const env = { CREDENTIALS_DIRECTORY: d };
    expect(readCredential('pg-url', {})).toBeUndefined();
    expect(readCredential('missing', env)).toBeUndefined();
    expect(readCredential('empty', env)).toBeUndefined();
    expect(readCredential('linked', env)).toBeUndefined();
    expect(readCredential('subdir', env)).toBeUndefined();
    for (const name of ['../secret', '/etc/passwd', 'a/b', '', '.hidden']) expect(readCredential(name, env), name).toBeUndefined();
  });
});

describe('buildClaudeEnv', () => {
  const source = {
    PATH: '/bin', HOME: '/h', LANG: 'C', TERM: 'xterm', TMPDIR: '/t',
    BULIG_WORKER_TOKEN: 'worker-secret', DATABASE_URL: 'postgres://u:p@h/db', PG_URL: 'postgres://x', TELEGRAM_TOKEN: 'tg', GH_TOKEN: 'gh', CREDENTIALS_DIRECTORY: '/run/credentials/bulig.service',
  };

  it('keeps worker tokens, the database URL, the Telegram and GitHub tokens and the credentials directory out of Claude', () => {
    const env = buildClaudeEnv(source);
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'C', TERM: 'xterm', TMPDIR: '/t' });
  });

  it('takes the Claude login from the claude-token credential, into the child\'s environment only', () => {
    const d = credDir({ 'claude-token': 'sk-ant-oat-from-file\n' });
    const parent = { ...source, CREDENTIALS_DIRECTORY: d };
    const env = buildClaudeEnv(parent);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-from-file');
    expect(env).not.toHaveProperty('CREDENTIALS_DIRECTORY');
    expect(parent).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN'); // the parent is not changed
  });

  it('a login already in the environment wins, as on the Mac', () => {
    const d = credDir({ 'claude-token': 'from-file' });
    expect(buildClaudeEnv({ ...source, CREDENTIALS_DIRECTORY: d, CLAUDE_CODE_OAUTH_TOKEN: 'from-env' }).CLAUDE_CODE_OAUTH_TOKEN).toBe('from-env');
    expect(buildClaudeEnv({ ...source, CREDENTIALS_DIRECTORY: d, ANTHROPIC_API_KEY: 'key' })).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('with no credentials directory it is exactly the old allowlist', () => {
    expect(buildClaudeEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', OTHER: 'x' })).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'k' });
  });
});

describe('the sandbox', () => {
  it('cannot read the unit\'s credential files, even though they are readable by its user', () => {
    expect(DENY_READ).toContain('/run/credentials');
    const settings = sandboxSettings() as { sandbox: { filesystem: { denyRead: string[] } } };
    expect(settings.sandbox.filesystem.denyRead).toContain('/run/credentials');
  });
});
