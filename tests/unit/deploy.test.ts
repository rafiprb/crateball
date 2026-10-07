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
    // Passed straight to docker build, never copied into the uploaded tree (a symlink there would
    // redirect the copy onto a host file): see deploy-script.test.ts for real malicious archives.
    expect(code).toContain('docker build -q -f "$CONF/Dockerfile"');
    expect(code).not.toMatch(/\bcp\b/);
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

  it('Caddy güvenlik başlıkları: çerçeveleme yok, HSTS, nosniff, referrer; fontlar ve soket izinli', () => {
    const caddy = read('deploy/Caddyfile');
    const csp = /Content-Security-Policy "([^"]+)"/.exec(caddy)?.[1] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    expect(csp).toMatch(/connect-src [^;]*wss:\/\/\{\$CRATEBALL_SITE:playcrateball\.com\}/);
    // On the server the site placeholder is unset: the default is the real site.
    expect(caddy).toMatch(/^\{\$CRATEBALL_SITE:playcrateball\.com\} \{/m);
    expect(csp).toMatch(/connect-src [^;]*ipc:/); // the desktop app's fullscreen keys
    expect(caddy).toMatch(/Strict-Transport-Security "max-age=\d+/);
    expect(caddy).toContain('X-Content-Type-Options "nosniff"');
    expect(caddy).toContain('Referrer-Policy');
  });

  it('yapı girdileri sabitlenmiş: Actions commit SHA, imajlar digest', () => {
    for (const wf of ['ci', 'release', 'desktop']) {
      const y = read(`.github/workflows/${wf}.yml`);
      for (const m of y.matchAll(/uses: (\S+)/g)) expect(m[1], wf).toMatch(/@[0-9a-f]{40}$/);
    }
    for (const m of read('Dockerfile').matchAll(/^FROM (\S+)/gm))
      expect(m[1]).toMatch(/@sha256:[0-9a-f]{64}/);
    for (const m of read('deploy/compose.yml').matchAll(/image: (\S+)/g))
      if (!m[1]!.startsWith('crateball:')) expect(m[1]).toMatch(/@sha256:[0-9a-f]{64}/);
  });

  it('masaüstü: yalnızca http/https dışarı açılır, gömülü sayfada CSP var, prodda localhost izni yok', () => {
    const rs = read('desktop/src-tauri/src/main.rs');
    expect(rs).toMatch(/matches!\(url\.scheme\(\), "http" \| "https"\)/);
    expect(rs).not.toMatch(/"about" \| "data" \| "blob"/);
    const conf = JSON.parse(read('desktop/src-tauri/tauri.conf.json')) as {
      app: { security: { csp: unknown } };
    };
    expect(conf.app.security.csp).not.toBeNull();
    expect(read('desktop/src-tauri/capabilities/game.json')).not.toContain('localhost');
  });
});
