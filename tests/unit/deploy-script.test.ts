import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Runs deploy/remote-deploy.sh for real, in a temp dir: its fixed paths point there and `docker` is a stub
 * that only records what it is asked. Archives are built with Python's tarfile, so they can hold exactly
 * the entries an attacker would put in (symlinks, hard links, ../ and absolute paths).
 */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-'));
  const conf = join(dir, 'etc');
  const bin = join(dir, 'bin');
  for (const d of [conf, bin, join(dir, 'opt'), join(dir, 'state'), join(dir, 'lock')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(conf, 'compose.yml'), 'services: {}\n');
  writeFileSync(join(conf, 'Caddyfile'), 'ORIGINAL CADDYFILE\n');
  writeFileSync(join(conf, 'Dockerfile'), 'FROM scratch\n');
  const script = readFileSync(join(root, 'deploy/remote-deploy.sh'), 'utf8')
    .replace('CONF=/etc/crateball', `CONF=${conf}`)
    .replace('SRC=/opt/crateball/src', `SRC=${join(dir, 'opt/src')}`)
    .replace('STATE=/var/lib/crateball', `STATE=${join(dir, 'state')}`)
    .replace('/var/lock/crateball-deploy.lock', join(dir, 'lock/deploy.lock'));
  writeFileSync(join(dir, 'deploy.sh'), script);
  const calls = join(dir, 'docker-calls');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('docker', `echo "$*" >> '${calls}'\ncase "$*" in *wget*) echo '{"ok":true}';; esac\nexit 0`);
  stub('flock', 'exit 0'); // not on macOS; the lock itself is not under test
  const run = (entries: string) => {
    const tar = join(dir, `release-${Math.random().toString(36).slice(2)}.tar`);
    const py = spawnSync('python3', [
      '-c',
      `import tarfile, io\nt = tarfile.open(${JSON.stringify(tar)}, 'w')\n${entries}\nt.close()`,
    ]);
    expect(py.status, py.stderr.toString()).toBe(0);
    const r = spawnSync('sh', [join(dir, 'deploy.sh'), 'deploy', 'test', 'force'], {
      input: readFileSync(tar),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { status: r.status, err: r.stderr.toString() };
  };
  const calls_ = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
  return { dir, conf, run, calls: calls_ };
}

const file = (name: string, text = 'x') =>
  `d = ${JSON.stringify(text)}.encode()\ni = tarfile.TarInfo(${JSON.stringify(name)}); i.size = len(d)\nt.addfile(i, io.BytesIO(d))`;
const link = (name: string, target: string, type: 'SYMTYPE' | 'LNKTYPE') =>
  `i = tarfile.TarInfo(${JSON.stringify(name)}); i.type = tarfile.${type}; i.linkname = ${JSON.stringify(target)}\nt.addfile(i)`;

describe('yayın betiği: kötü niyetli arşiv', () => {
  it('düzgün arşiv derlenir; sabit Dockerfile ağacın dışından -f ile verilir', () => {
    const h = harness();
    const r = h.run([file('package.json', '{}'), file('src/a.ts')].join('\n'));
    expect(r.status, r.err).toBe(0);
    expect(h.calls()).toContain(`build -q -f ${h.conf}/Dockerfile`);
  });

  it("sembolik bağlantı (sabit Caddyfile'a) reddedilir; host dosyası değişmez, derleme yapılmaz", () => {
    const h = harness();
    const r = h.run(
      [file('package.json'), link('.crateball.Dockerfile', `${h.conf}/Caddyfile`, 'SYMTYPE')].join('\n'),
    );
    expect(r.status).not.toBe(0);
    expect(r.err).toContain('release rejected');
    expect(readFileSync(`${h.conf}/Caddyfile`, 'utf8')).toBe('ORIGINAL CADDYFILE\n');
    expect(h.calls()).not.toContain('build');
  });

  it('sabit bağlantı (hard link) reddedilir', () => {
    const h = harness();
    const r = h.run([file('a'), link('b', 'a', 'LNKTYPE')].join('\n'));
    expect(r.status).not.toBe(0);
    expect(h.calls()).not.toContain('build');
  });

  it('../ ve mutlak yollar reddedilir; ağacın dışına hiçbir şey yazılmaz', () => {
    const h = harness();
    for (const name of ['../escaped', 'src/../../escaped', '/tmp/crateball-escaped']) {
      const r = h.run([file('ok'), file(name, 'pwned')].join('\n'));
      expect(r.status, name).not.toBe(0);
    }
    expect(existsSync(join(h.dir, 'opt/escaped'))).toBe(false);
    expect(existsSync(join(h.dir, 'escaped'))).toBe(false);
    expect(h.calls()).not.toContain('build');
  });
});
