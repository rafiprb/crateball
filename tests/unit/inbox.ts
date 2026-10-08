import { createSnapDecoder, decodeServerData, type ServerMessage } from '../../packages/protocol/src/index';

/** A room's send callback that decodes everything on arrival (binary snapshots with this recipient's own
 * decoder, in order) and keeps the messages. */
export function inboxSend(out: Array<ServerMessage | null>) {
  const dec = createSnapDecoder();
  return (raw: string | Uint8Array) => {
    out.push(decodeServerData(raw, dec));
    return true;
  };
}
