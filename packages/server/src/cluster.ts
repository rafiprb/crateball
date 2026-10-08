/**
 * Several game processes (CRATEBALL_WORKERS > 0). One process runs out of one CPU core; rooms are
 * independent, so they are spread over worker processes:
 *
 * - The coordinator (coordinator.ts) owns the HTTP port. It serves the page, /health and /rooms, checks
 *   every WebSocket upgrade (origin, caps, per-address limits: it sees all of them) and hands the TCP
 *   socket itself to a worker, which completes the upgrade. After that the coordinator carries no game
 *   traffic: a worker reads and writes its sockets directly.
 * - A room code says which worker holds the room (its first letter, `codeOwner`). `/ws?room=CODE` goes
 *   straight there; a plain `/ws` (the menu) goes to the worker with the fewest sockets, which creates
 *   rooms in its own share of codes. A join for a room elsewhere is answered `moved`, and the client
 *   connects again with `?room=`.
 * - Reconnect tokens carry a MAC under a secret every worker knows, so a token stays valid across them.
 * - Workers report their counts twice a second; the coordinator adds them up for the caps, /health and
 *   /rooms, and writes one stats line for all of them.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { CODE_ALPHABET, type RoomListing } from '@crateball/protocol';
import type { ServerConfig } from './config';
import type { Sample } from './metrics';

/** The worker that holds the room with this code. */
export const codeOwner = (code: string, workers: number): number =>
  Math.max(0, CODE_ALPHABET.indexOf(code[0] ?? '')) % workers;

/** Worker load reports, and the totals sent back, this often. */
export const LOAD_MS = 500;

export interface Load {
  rooms: number;
  members: number;
  playing: number;
  sockets: number;
  /** Its public rooms (GET /rooms). */
  list: RoomListing[];
}

export type ToWorker =
  | { t: 'init'; k: number; n: number; cfg: ServerConfig; secret: string; quiet: boolean }
  /** With the socket as the handle: finish this upgrade. `head`: bytes already read past the request. */
  | { t: 'upgrade'; url: string; headers: IncomingHttpHeaders; head: string; ip: string }
  /** Rooms and people in the other workers (the caps count the whole server). */
  | { t: 'elsewhere'; rooms: number; members: number };

export type FromWorker =
  | { t: 'ready' }
  | ({ t: 'load' } & Load)
  | { t: 'stats'; sample: Sample }
  /** A socket it was handed is gone (also one whose upgrade failed). */
  | { t: 'closed'; ip: string };
