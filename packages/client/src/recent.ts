/**
 * Recent matches on this device: the goals of the last few matches played here, as the server sent them
 * at the final whistle, kept in IndexedDB (binary as it is, written once, never on the game's hot path).
 * A convenience only: private windows, cleared site data and Safari's 7-day rule can empty it; a goal
 * someone wants to keep is downloaded as a file.
 */
import { PROTOCOL_VERSION, isReplay } from '@crateball/protocol';
import type { Team } from '@crateball/sim';

/** Matches kept; the oldest goes when a new one comes in. */
export const RECENT_MAX = 10;

export interface RecentMatch {
  /** When it ended (server clock): also its key, so the same match is never kept twice. */
  at: number;
  score: [number, number];
  goals: number;
  /** The side this player was on (null: watching). */
  you: Team | null;
  bytes: Uint8Array;
}

const DB = 'crateball';
const STORE = 'recent';

let opening: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  opening ??= new Promise((done) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'at' });
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      done(null); // no IndexedDB (blocked storage): no recent matches, nothing else changes
    }
  });
  return opening;
}

const ask = <T>(req: IDBRequest<T>) =>
  new Promise<T>((done, fail) => {
    req.onsuccess = () => done(req.result);
    req.onerror = () => fail(req.error ?? new Error('IndexedDB'));
  });

/** The version a replay was made in (right after its magic), without decoding the rest. */
function versionOf(bytes: Uint8Array): number {
  let n = 0;
  let mul = 1;
  for (let i = 4; i < Math.min(bytes.length, 12); i++) {
    n += (bytes[i]! & 0x7f) * mul;
    if (bytes[i]! < 0x80) return n;
    mul *= 0x80;
  }
  return -1;
}

export async function saveRecent(m: RecentMatch): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(m);
    const keys = (await ask(store.getAllKeys())) as number[];
    keys.sort((a, b) => a - b);
    for (const k of keys.slice(0, Math.max(0, keys.length - RECENT_MAX))) store.delete(k);
  } catch {
    /* storage full or blocked: the match is just not kept */
  }
}

/** Newest first. Matches made with another version of the game are dropped (they could not play). */
export async function listRecent(): Promise<RecentMatch[]> {
  const d = await db();
  if (!d) return [];
  try {
    const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
    const all = (await ask(store.getAll())) as RecentMatch[];
    const ok: RecentMatch[] = [];
    for (const m of all) {
      if (m.bytes instanceof Uint8Array && isReplay(m.bytes) && versionOf(m.bytes) === PROTOCOL_VERSION)
        ok.push(m);
      else store.delete(m.at);
    }
    return ok.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}
