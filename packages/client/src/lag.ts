import type { SocketLike } from './net';

/**
 * Dev-only fake network: `?lag=100` adds 100 ms one way (≈200 ms ping), `&jitter=30` adds up to 30 ms
 * random extra. Order is preserved like real TCP (a message never overtakes the one before it).
 */
export function laggySocket(url: string, lagMs: number, jitterMs: number): SocketLike {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let lastOut = 0;
  let lastIn = 0;
  const delay = (last: number) => Math.max(last, performance.now() + lagMs + Math.random() * jitterMs);
  const later = (at: number, fn: () => void) => setTimeout(fn, at - performance.now());
  const s: SocketLike = {
    send(data) {
      lastOut = delay(lastOut);
      later(lastOut, () => ws.readyState === WebSocket.OPEN && ws.send(data));
    },
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => s.onopen?.();
  ws.onclose = () => s.onclose?.();
  ws.onmessage = (ev) => {
    lastIn = delay(lastIn);
    const data: unknown = ev.data;
    later(lastIn, () => s.onmessage?.({ data }));
  };
  return s;
}
