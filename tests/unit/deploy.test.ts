import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string) => readFileSync(root + p, 'utf8');

// The deploy key may only run crateball-deploy. Whatever decides what runs on the host must come from
// root-owned files on the server, never from the uploaded release (a stolen key = host root otherwise).
describe('yayın: yüklenen arşiv yalnızca derleme bağlamı', () => {
  const script = read('deploy/remote-deploy.sh');
  const code = script
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  it('betik kendini arşivden kurmaz', () => {
    expect(code).not.toMatch(/install\b.*crateball-deploy/);
    expect(code).not.toMatch(/remote-deploy\.sh/);
  });

  it('compose, Caddyfile ve Dockerfile sabit /etc/crateball dosyalarından gelir', () => {
    expect(code).toContain('CONF=/etc/crateball');
    expect(code).toContain('docker compose -f $CONF/compose.yml');
    expect(code).toMatch(/cp "\$CONF\/Dockerfile"/);
    // Nothing from the extracted upload is used as compose input.
    expect(code).not.toMatch(/\$SRC[^ ]*\/deploy\//);
    expect(code).not.toMatch(/compose build/);
  });

  it('maç beklenir ve sağlıksızsa önceki imaja dönülür', () => {
    expect(code).toContain('crateball:previous');
    expect(code).toMatch(/"\$FORCE" != "force"/);
  });

  it('sabit compose: derleme yok, konteynerler kısıtlı', () => {
    const compose = read('deploy/compose.yml');
    expect(compose).not.toMatch(/^\s*build:/m);
    for (const svc of ['game', 'caddy']) {
      const block = compose.split(/\n {2}(?=\w+:\n)/).find((b) => b.startsWith(svc + ':'))!;
      expect(block, svc).toMatch(/cap_drop: \[ALL\]/);
      expect(block, svc).toMatch(/no-new-privileges:true/);
      expect(block, svc).toMatch(/mem_limit:/);
      expect(block, svc).toMatch(/pids_limit:/);
      expect(block, svc).toMatch(/read_only: true/);
    }
  });

  it('Docker bağlamına operasyon sırları girmez', () => {
    const ignore = read('.dockerignore').split('\n');
    for (const p of ['.deploy.env', '.grafana.env', '*.pem', '*.key', 'id_*']) expect(ignore).toContain(p);
  });
});
