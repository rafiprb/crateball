// Grafana alerts for production, sent to Telegram. Creates or updates (by fixed uids, so running it again
// is safe) a "Crateball" folder, a Telegram contact point and one rule group, through Grafana's
// provisioning API. Secrets come from .alerts.env in the repo root (gitignored, never sent to the server;
// template deploy/monitoring/alerts.env.example).
//
// Usage:
//   node scripts/alerts.mjs chat     after messaging the bot once: prints the chat id to put in .alerts.env
//   node scripts/alerts.mjs ping     sends a test message to that chat
//   node scripts/alerts.mjs plan     prints the rules without touching Grafana
//   node scripts/alerts.mjs          installs or updates everything in Grafana
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const env = {};
try {
  for (const line of readFileSync(path.join(ROOT, '.alerts.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch {
  /* no file yet: `plan` still works, everything else asks for it */
}
const need = (k) =>
  env[k] ||
  (console.error(`.alerts.env içinde ${k} yok (şablon: deploy/monitoring/alerts.env.example)`),
  process.exit(1));

/** Everyone in rooms, server-wide (CRATEBALL_MAX_PLAYERS; DEFAULT_CAPS in packages/server/src/config.ts). */
const CAP = Number(env.ALERT_PLAYER_CAP || 90);
const INSTANCE = 'crateball-prod';
const FOLDER = { uid: 'crateball', title: 'Crateball' };
const GROUP = 'production';
const RECEIVER = 'Crateball Telegram';
/** Synthetic Monitoring check on the site from outside (its job name in Grafana). */
const SITE_JOB = 'crateball-health';

// One line per alert: "ALARM: …" when it fires, "DÜZELDİ: …" when it clears.
const MESSAGE =
  '{{ range .Alerts }}{{ if eq .Status "firing" }}ALARM{{ else }}DÜZELDİ{{ end }}: {{ .Annotations.summary }}\n{{ end }}';

const telegram = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${need('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
};

// ── Rules ─────────────────────────────────────────────────────────────────────────────────────────
/** The game's 5 s `sunucu istatistik` line (packages/server/src/metrics.ts): the highest value of a field
 * over the last two minutes. The line is only written while someone is connected: no data means idle. */
const stat = (field) =>
  `max(max_over_time({job="crateball", msg="sunucu istatistik"} | json v="${field}" | unwrap v [2m]))`;
const host = (q) => q.replaceAll('$I', `instance="${INSTANCE}"`);
const n = (ref = 'A') => `{{ printf "%.0f" $values.${ref}.Value }}`;

const RULES = [
  {
    uid: 'crateball-full',
    title: 'Sunucu dolu',
    ds: 'logs',
    expr: stat('players'),
    above: CAP - 1,
    for: '0s',
    summary: `Sunucu dolu (${n()} kişi, sınır ${CAP}): yeni gelenler "servers are full" görüyor.`,
  },
  {
    uid: 'crateball-players',
    title: 'Oyuncu sayısı sınıra yakın',
    ds: 'logs',
    expr: stat('players'),
    above: Math.floor(CAP * 0.8),
    for: '1m',
    summary: `Oyunda ${n()} kişi var, sınır ${CAP}. Dolmak üzere.`,
  },
  {
    uid: 'crateball-tick',
    title: 'Oyun yavaşlıyor',
    ds: 'logs',
    // The average, not the slowest tick: single 10-35 ms ticks come every few minutes even with one
    // player (they alerted 4 times on launch day) and nobody feels them. The average is ~1 ms.
    expr: stat('tickMsAvg'),
    above: 8,
    for: '5m',
    summary: `Ortalama tick ${n()} ms (bütçe 16.7 ms, normalde 1 ms civarı). Oyuncular yakında takılma görür.`,
  },
  {
    uid: 'crateball-crash',
    title: 'Oyun süreci çöktü',
    ds: 'logs',
    expr: 'sum(count_over_time({job="crateball", msg=~"oyun süreci (düştü|cevap vermiyor|30 sn|başlatılamadı).*"}[5m]))',
    above: 0,
    for: '0s',
    summary: `Son 5 dakikada bir oyun süreci ${n()} kez düştü ya da donup yeniden başlatıldı; içindeki maçlar kesildi.`,
  },
  {
    uid: 'crateball-errors',
    title: 'Hata yağmuru',
    ds: 'logs',
    expr: 'sum(count_over_time({job="crateball", level=~"50|60"}[5m]))',
    above: 20,
    for: '0s',
    summary: `Son 5 dakikada ${n()} hata satırı. Grafana'da "Uyarı ve hatalar" paneline bak.`,
  },
  {
    uid: 'crateball-down',
    title: 'Sunucudan ses yok',
    ds: 'prom',
    expr: host('absent_over_time(node_load1{$I}[5m])'),
    above: 0,
    for: '0s',
    summary: '5 dakikadır sunucudan hiç veri gelmiyor: sunucu kapalı ya da izleme ajanı durmuş.',
  },
  {
    // Grafana Synthetic Monitoring, HTTP check with job name crateball-health on /health from two probes
    // (made in the Grafana UI). Fires when no probe got through for 3 minutes.
    uid: 'crateball-site',
    title: 'Site dışarıdan açılmıyor',
    ds: 'prom',
    expr: `max(max_over_time(probe_success{job="${SITE_JOB}"}[3m]))`,
    below: 1,
    for: '0s',
    summary:
      '3 dakikadır dışarıdan hiçbir yoklama playcrateball.com/health adresine ulaşamıyor: oyuncular siteyi açamıyor.',
  },
  {
    uid: 'crateball-cpu',
    title: 'İşlemci dolu',
    ds: 'prom',
    expr: host('100 * (1 - avg(rate(node_cpu_seconds_total{$I, mode="idle"}[5m])))'),
    above: 85,
    for: '5m',
    summary: `İşlemci 5 dakikadır %${n()} dolu.`,
  },
  {
    uid: 'crateball-memory',
    title: 'Bellek dolmak üzere',
    ds: 'prom',
    expr: host('100 * (1 - node_memory_MemAvailable_bytes{$I} / node_memory_MemTotal_bytes{$I})'),
    above: 90,
    for: '5m',
    summary: `Bellek %${n()} dolu.`,
  },
  {
    uid: 'crateball-disk',
    title: 'Disk dolmak üzere',
    ds: 'prom',
    expr: host(
      '100 * (1 - node_filesystem_avail_bytes{$I, mountpoint="/"} / node_filesystem_size_bytes{$I, mountpoint="/"})',
    ),
    above: 85,
    for: '10m',
    summary: `Disk %${n()} dolu.`,
  },
];

function rule(r, uids) {
  const model =
    r.ds === 'logs'
      ? { refId: 'A', expr: r.expr, queryType: 'instant' }
      : { refId: 'A', expr: r.expr, instant: true, range: false };
  return {
    uid: r.uid,
    title: r.title,
    ruleGroup: GROUP,
    folderUID: FOLDER.uid,
    condition: 'C',
    data: [
      { refId: 'A', relativeTimeRange: { from: 600, to: 0 }, datasourceUid: uids[r.ds], model },
      {
        refId: 'C',
        datasourceUid: '__expr__',
        relativeTimeRange: { from: 0, to: 0 },
        model: {
          refId: 'C',
          type: 'threshold',
          expression: 'A',
          conditions: [
            {
              evaluator:
                r.below === undefined ? { type: 'gt', params: [r.above] } : { type: 'lt', params: [r.below] },
            },
          ],
        },
      },
    ],
    // Quiet when idle (no stats lines) and through a short hiccup of Grafana's own data sources.
    noDataState: 'OK',
    execErrState: 'KeepLast',
    for: r.for,
    annotations: { summary: r.summary },
    labels: { service: 'crateball' },
    notification_settings: { receiver: RECEIVER },
    isPaused: false,
  };
}

// ── Grafana ───────────────────────────────────────────────────────────────────────────────────────
const grafana = async (method, url, body) => {
  const res = await fetch(`${need('GRAFANA_URL').replace(/\/$/, '')}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${need('GRAFANA_ALERTS_TOKEN')}`,
      'content-type': 'application/json',
      // Left editable in the Grafana UI (not locked as "provisioned").
      'x-disable-provenance': 'true',
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${url}: ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

async function sources() {
  const all = (await grafana('GET', '/api/datasources')).json;
  const pick = (type, suffix) =>
    all.find((d) => d.type === type && d.name.endsWith(suffix)) ?? all.find((d) => d.type === type);
  const prom = pick('prometheus', '-prom');
  const logs = pick('loki', '-logs');
  if (!prom || !logs) throw new Error('Grafana içinde Prometheus ya da Loki veri kaynağı bulunamadı');
  return { prom: prom.uid, logs: logs.uid, names: [prom.name, logs.name] };
}

async function install() {
  const uids = await sources();
  console.log('veri kaynakları:', uids.names.join(', '));
  if ((await grafana('GET', `/api/folders/${FOLDER.uid}`)).status === 404)
    await grafana('POST', '/api/folders', FOLDER);
  const point = {
    uid: 'crateball-telegram',
    name: RECEIVER,
    type: 'telegram',
    settings: { bottoken: need('TELEGRAM_BOT_TOKEN'), chatid: need('TELEGRAM_CHAT_ID'), message: MESSAGE },
    disableResolveMessage: false,
  };
  const points = (await grafana('GET', '/api/v1/provisioning/contact-points')).json;
  if (points.some((p) => p.uid === point.uid))
    await grafana('PUT', `/api/v1/provisioning/contact-points/${point.uid}`, point);
  else await grafana('POST', '/api/v1/provisioning/contact-points', point);
  console.log('kişi noktası:', RECEIVER);
  await grafana('PUT', `/api/v1/provisioning/folder/${FOLDER.uid}/rule-groups/${GROUP}`, {
    title: GROUP,
    folderUid: FOLDER.uid,
    interval: 60,
    rules: RULES.map((r) => rule(r, uids)),
  });
  for (const r of RULES) console.log('kural:', r.title);
}

const cmd = process.argv[2] ?? 'install';
if (cmd === 'chat') {
  const updates = await telegram('getUpdates');
  const chats = new Map(
    updates
      .map((u) => u.message?.chat ?? u.my_chat_member?.chat)
      .filter(Boolean)
      .map((c) => [c.id, c]),
  );
  if (!chats.size)
    console.log('Bota henüz mesaj gelmemiş: Telegram’da bota bir mesaj yaz, sonra tekrar çalıştır.');
  for (const c of chats.values())
    console.log(`TELEGRAM_CHAT_ID=${c.id}  (${c.title ?? c.first_name ?? c.type})`);
} else if (cmd === 'ping') {
  await telegram('sendMessage', {
    chat_id: need('TELEGRAM_CHAT_ID'),
    text: 'Crateball alarmları bu sohbete gelecek.',
  });
  console.log('gönderildi');
} else if (cmd === 'plan') {
  for (const r of RULES)
    console.log(
      `${r.title}: ${r.expr} ${r.below === undefined ? `> ${r.above}` : `< ${r.below}`} (${r.for})\n  ${r.summary}`,
    );
} else if (cmd === 'install') {
  await install();
} else {
  console.error('kullanım: node scripts/alerts.mjs [chat|ping|plan]');
  process.exit(1);
}
