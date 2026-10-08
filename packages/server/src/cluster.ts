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
 *   Joining a room in one worker releases the player's slot held for a reconnect in another (`release`).
 * - Caps and per-address budgets are split into fixed shares per worker that add up to the server's
 *   (`share`): each worker runs on its own core, so its share is also what that core can carry. No worker
 *   has to wait for the others to decide.
 * - Workers report their counts twice a second; the coordinator adds them up for /health and /rooms, and
 *   writes one stats line for all of them. Every socket it hands over is reported back once when it ends
 *   (also one that never arrived), so its socket and per-address counts cannot leak.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { CODE_ALPHABET, type RoomListing } from '@crateball/protocol';
import type { ServerConfig } from './config';
import type { Sample } from './metrics';

/** The worker that holds the room with this code. */
export const codeOwner = (code: string, workers: number): number =>
  Math.max(0, CODE_ALPHABET.indexOf(code[0] ?? '')) % workers;

/** Worker load reports this often. */
export const LOAD_MS = 500;

/** Worker k's share of a server-wide limit: the shares of all n workers add up to exactly `total`. */
export const share = (total: number, k: number, n: number): number =>
  Math.floor(total / n) + (k < total % n ? 1 : 0);

/** A per-address budget for one of n workers: an address's rooms spread over the workers, so a rounded-up
 * share keeps an office fine, and the sum stays within n - 1 of the single-process budget. */
export const budgetShare = (total: number, n: number): number => Math.max(1, Math.ceil(total / n));

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
  /** That session joined a room in another worker: let go of its slot here if it is only held for a
   * reconnect (it moved on; as in one process, where joining a room leaves the old one). */
  | { t: 'release'; key: string };

export type FromWorker =
  | { t: 'ready' }
  | ({ t: 'load' } & Load)
  | { t: 'stats'; sample: Sample }
  /** A socket it was handed is gone (also one whose upgrade failed, or whose handle never arrived). */
  | { t: 'closed'; ip: string }
  /** This session is now in a room here. */
  | { t: 'entered'; key: string };
