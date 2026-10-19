import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeTelegram, until } from './fake-telegram.ts';
import { boot, shutdown, TOKEN_ENV } from './harness.ts';

// The bot token comes from a systemd credential on a server and from an environment variable on the Mac. The fake Telegram answers 401
// to any token but its own, and records only calls that carried the right one.

const dirs: string[] = [];
const fakes: FakeTelegram[] = [];
const saved = { ...process.env };
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});
const fake = async (token: string) => {
  const f = await new FakeTelegram(token).start();
  fakes.push(f);
  return f;
};
const credentials = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'bulig-tgcred-'));
  dirs.push(d);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(d, name), value + '\n');
    chmodSync(join(d, name), 0o400);
  }
  process.env.CREDENTIALS_DIRECTORY = d;
};

describe('the Telegram bot token', () => {
  it('a credential file wins over the environment variable', async () => {
    const f = await fake('bot-from-the-credential');
    process.env[TOKEN_ENV] = 'a-wrong-token-from-env';
    credentials({ 'telegram-token': 'bot-from-the-credential' });
    const b = await boot(f);
    try {
      await until(() => f.calls.length > 0, 'a call carrying the right token');
      expect(f.calls.length).toBeGreaterThan(0);
    } finally {
      await shutdown(b);
    }
  });

  it('a credential under another name is used when tokenCredential names it', async () => {
    const f = await fake('bot-from-the-credential');
    process.env[TOKEN_ENV] = 'a-wrong-token-from-env';
    credentials({ 'my-bot': 'bot-from-the-credential' });
    const b = await boot(f, { tokenCredential: 'my-bot' });
    try {
      await until(() => f.calls.length > 0, 'a call carrying the right token');
    } finally {
      await shutdown(b);
    }
  });

  it('on the Mac the environment variable still works', async () => {
    const f = await fake('bot-from-env');
    delete process.env.CREDENTIALS_DIRECTORY;
    process.env[TOKEN_ENV] = 'bot-from-env';
    const b = await boot(f);
    try {
      await until(() => f.calls.length > 0, 'a call carrying the right token');
    } finally {
      await shutdown(b);
    }
  });

  it('with neither, the plugin stops at start and says what to set', async () => {
    const f = await fake('whatever');
    delete process.env[TOKEN_ENV];
    credentials({ 'something-else': 'x' });
    await expect(boot(f)).rejects.toThrow(/bot token is not set.*telegram-token/);
    await expect(boot(f, { tokenCredential: 'my-bot' })).rejects.toThrow(/credential my-bot/);
  });
});
