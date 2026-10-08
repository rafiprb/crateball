import { chmodSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer, type Server as NetServer } from 'node:net';

/**
 * Feeds connections from a Unix socket into an HTTP server that already listens on TCP: everything
 * (requests, upgrades, the hand-over to workers) works the same on both. Caddy uses the socket in
 * production; health checks keep using TCP.
 */
export async function listenUnix(server: Server, path: string): Promise<NetServer> {
  rmSync(path, { force: true }); // left over from the last run
  const unix = createServer((c) => server.emit('connection', c));
  await new Promise<void>((resolve, reject) => {
    unix.once('error', reject);
    unix.listen(path, () => {
      unix.off('error', reject);
      resolve();
    });
  });
  // Caddy's container runs as another user; the socket lives in a volume only the two of them share.
  chmodSync(path, 0o666);
  return unix;
}
