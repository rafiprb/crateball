import {
  PROTOCOL_VERSION,
  createSnapDecoder,
  decodeServerData,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@crateball/protocol';

/** Unsent bytes on the socket above which inputs are dropped (about 40 inputs, under a second). */
const STALL_BYTES = 1024;

/** `taken`: this tab connected again elsewhere (a duplicated tab); this one stops. */
export type NetStatus = 'connecting' | 'open' | 'closed' | 'version_mismatch' | 'taken';

/** Server close code: a newer socket of the same session replaced this one. */
const CLOSE_TAKEN_OVER = 4011;
/** Nothing heard for this long (the server answers a ping every second): the link is dead. */
export const STALL_MS = 6000;

export interface SocketLike {
  send(data: string): void;
  close(): void;
  /** Bytes queued but not yet sent (a real WebSocket has it; test doubles may leave it out). */
  readonly bufferedAmount?: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: { code?: number }) => void) | null;
}

export interface ConnectionOptions {
  /** Read at every (re)connect: it names the room this tab is in or going to (`?room=`), so the server
   * can hand the socket straight to the process that holds it. */
  url: string | (() => string);
  createSocket?: (url: string) => SocketLike;
  /** Sent in hello so the server can give a reconnecting tab its old slot back (server-issued). */
  sessionToken?: string;
  /** The server issued (or confirmed) this tab's reconnect token. */
  onToken?: (token: string) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
  now?: () => number;
  onStatus?: (status: NetStatus) => void;
  /** Every decoded message after the welcome handshake. */
  onMessage?: (m: ServerMessage) => void;
  /** The server's release, from the welcome handshake. */
  onServerVersion?: (version: string) => void;
  /** Maintenance on or off, from every welcome (a `maintenance` message arrives via onMessage). */
  onMaintenance?: (on: boolean) => void;
}

export interface Connection {
  readonly status: NetStatus;
  readonly clientId: string | null;
  readonly attempts: number;
  send(m: ClientMessage): void;
  /** Connect again right away (the URL changed: the server said the room is elsewhere). */
  reconnect(): void;
  close(): void;
}

export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10000];

export function connect(o: ConnectionOptions): Connection {
  const createSocket =
    o.createSocket ??
    ((url: string) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer'; // snapshots are binary frames
      return ws as unknown as SocketLike;
    });
  const schedule = o.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let status: NetStatus = 'connecting';
  let clientId: string | null = null;
  let attempts = 0;
  let stopped = false;
  let socket: SocketLike | null = null;
  const queued: ClientMessage[] = [];
  const now = o.now ?? (() => Date.now());
  let sessionToken = o.sessionToken;
  let heardAt = now();

  const setStatus = (s: NetStatus) => {
    status = s;
    o.onStatus?.(s);
  };

  const open = () => {
    if (stopped) return; // close() bekleyen yeniden denemeyi de iptal eder
    setStatus('connecting');
    const s = createSocket(typeof o.url === 'string' ? o.url : o.url());
    socket = s;
    // Snapshot deltas build on the last one this connection got: a new connection starts from a key frame.
    const snaps = createSnapDecoder();
    s.onopen = () =>
      s.send(
        encode({
          t: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          ...(sessionToken ? { sessionToken } : {}),
        }),
      );
    s.onmessage = (ev) => {
      heardAt = now();
      const m = decodeServerData(ev.data, snaps);
      if (!m) return;
      if (m.t === 'welcome') {
        clientId = m.clientId;
        if (m.token && m.token !== sessionToken) {
          sessionToken = m.token;
          o.onToken?.(m.token);
        }
        if (m.version) o.onServerVersion?.(m.version);
        o.onMaintenance?.(m.maintenance === true);
        attempts = 0;
        setStatus('open');
        for (const q of queued.splice(0)) s.send(encode(q));
      } else if (m.t === 'error' && m.code === 'version_mismatch') {
        stopped = true;
        setStatus('version_mismatch');
      } else o.onMessage?.(m);
    };
    s.onclose = (ev) => {
      if (socket !== s) return;
      socket = null;
      clientId = null;
      if (status === 'version_mismatch') return;
      if (ev?.code === CLOSE_TAKEN_OVER) {
        stopped = true;
        setStatus('taken');
        return;
      }
      setStatus('closed');
      if (stopped) return;
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 10000;
      attempts++;
      schedule(open, delay);
    };
  };

  open();
  // A dead link (sleeping laptop, network switch) can look open for minutes: give up on it and
  // reconnect, which also gets the slot back through the session token.
  const watchdog = setInterval(() => {
    const s = socket;
    if (!s || status !== 'open' || now() - heardAt < STALL_MS) return;
    heardAt = now();
    const onclose = s.onclose;
    s.onmessage = null;
    s.onclose = null;
    s.close();
    onclose?.();
  }, 1000);
  return {
    get status() {
      return status;
    },
    get clientId() {
      return clientId;
    },
    get attempts() {
      return attempts;
    },
    send(m) {
      // Stalled link (data piling up unsent): skip inputs instead of queueing seconds of them to arrive
      // in one burst. The server stands in with the last keys meanwhile; the next input carries on.
      if (m.t === 'in' && (socket?.bufferedAmount ?? 0) > STALL_BYTES) return;
      if (socket && status === 'open') socket.send(encode(m));
      // A click before the handshake finishes (slow link) must not vanish; per-tick traffic is dropped.
      else if (m.t !== 'in' && m.t !== 'ping') queued.push(m);
    },
    reconnect() {
      const s = socket;
      // No socket: a retry is already scheduled, and it reads the new URL.
      if (!s || stopped) return;
      socket = null;
      clientId = null;
      s.onmessage = null;
      s.onclose = null;
      s.close();
      attempts = 0;
      open();
    },
    close() {
      stopped = true;
      clearInterval(watchdog);
      if (socket) socket.close();
      else setStatus('closed');
    },
  };
}
