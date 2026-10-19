import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, findConfigFile, loadConfig } from '../src/config.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Four places a config can be, each with a different dbPath so a test can tell which one was read. */
function places() {
  const root = mkdtempSync(join(tmpdir(), 'bulig-cfgsrc-'));
  dirs.push(root);
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  const creds = join(root, 'creds');
  const explicit = join(root, 'explicit.json');
  mkdirSync(cwd);
  mkdirSync(join(home, '.bulig'), { recursive: true });
  mkdirSync(creds);
  const write = (path: string, name: string, mode = 0o600) => {
    writeFileSync(path, JSON.stringify({ dbPath: `/db/${name}.sqlite` }));
    chmodSync(path, mode);
  };
  return {
    cwd, home, creds, explicit,
    credential: (mode?: number) => write(join(creds, 'config'), 'credential', mode),
    env: (mode?: number) => write(explicit, 'env', mode),
    local: () => write(join(cwd, 'bulig.config.json'), 'cwd', 0o644),
    homeFile: () => write(join(home, '.bulig', 'config.json'), 'home', 0o644),
  };
}
const dbOf = (cwd: string, home: string, env: Record<string, string | undefined>) => loadConfig(cwd, home, env).config.dbPath;

describe('where the config comes from', () => {
  it('the systemd credential wins over everything else', () => {
    const p = places();
    p.credential();
    p.env();
    p.local();
    p.homeFile();
    expect(dbOf(p.cwd, p.home, { CREDENTIALS_DIRECTORY: p.creds, BULIG_CONFIG: p.explicit })).toBe('/db/credential.sqlite');
  });

  it('BULIG_CONFIG comes next, then the working directory, then the home folder', () => {
    const p = places();
    p.env();
    p.local();
    p.homeFile();
    // a credentials directory with no config in it is skipped
    expect(dbOf(p.cwd, p.home, { CREDENTIALS_DIRECTORY: p.creds, BULIG_CONFIG: p.explicit })).toBe('/db/env.sqlite');
    expect(dbOf(p.cwd, p.home, { BULIG_CONFIG: p.explicit })).toBe('/db/env.sqlite');
    expect(dbOf(p.cwd, p.home, {})).toBe('/db/cwd.sqlite');
    rmSync(join(p.cwd, 'bulig.config.json'));
    expect(dbOf(p.cwd, p.home, {})).toBe('/db/home.sqlite');
  });

  it('with neither variable set it is what it was: the working directory, then the home folder', () => {
    const p = places();
    p.local();
    p.homeFile();
    expect(findConfigFile(p.cwd, p.home, {})).toBe(join(p.cwd, 'bulig.config.json'));
    expect(findConfigFile(p.cwd, p.home)).toBe(findConfigFile(p.cwd, p.home, process.env)); // the default is the process environment
  });

  it('a relative BULIG_CONFIG is read from the working directory', () => {
    const p = places();
    p.env();
    expect(dbOf(p.cwd, p.home, { BULIG_CONFIG: '../explicit.json' })).toBe('/db/env.sqlite');
  });

  it('BULIG_CONFIG must be a private regular file, and a missing one is an error, not a reason to look elsewhere', () => {
    const p = places();
    p.local();
    p.env(0o644);
    expect(() => loadConfig(p.cwd, p.home, { BULIG_CONFIG: p.explicit })).toThrow(/group or by anyone/);
    p.env(0o640);
    expect(() => loadConfig(p.cwd, p.home, { BULIG_CONFIG: p.explicit })).toThrow(ConfigError);
    expect(() => loadConfig(p.cwd, p.home, { BULIG_CONFIG: join(p.cwd, 'nope.json') })).toThrow(/does not exist/);
    expect(() => loadConfig(p.cwd, p.home, { BULIG_CONFIG: p.cwd })).toThrow(/not a regular file/);
    p.env(0o600);
    expect(dbOf(p.cwd, p.home, { BULIG_CONFIG: p.explicit })).toBe('/db/env.sqlite');
  });

  it('the credential is not mode-checked (systemd owns that directory)', () => {
    const p = places();
    p.credential(0o444);
    expect(dbOf(p.cwd, p.home, { CREDENTIALS_DIRECTORY: p.creds })).toBe('/db/credential.sqlite');
  });

  it('the "No config found" message lists all four places in order', () => {
    const p = places();
    let message = '';
    try {
      loadConfig(p.cwd, p.home, { CREDENTIALS_DIRECTORY: p.creds });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^No config found/);
    const at = [join(p.creds, 'config'), '$BULIG_CONFIG', join(p.cwd, 'bulig.config.json'), join(p.home, '.bulig', 'config.json')].map((x) => message.indexOf(x));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});
