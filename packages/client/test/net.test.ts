import { describe, expect, it } from 'vitest';
import { connect, type SocketLike } from '../src/net';

describe('bağlantı', () => {
  it('el sıkışmadan önce gönderilen menü mesajı kaybolmaz, tick girdisi kuyruğa girmez', () => {
    const sent: string[] = [];
    let sock!: SocketLike;
    const conn = connect({
      url: 'ws://x',
      createSocket: () =>
        (sock = { send: (d) => sent.push(d), close: () => {}, onopen: null, onmessage: null, onclose: null }),
    });
    conn.send({ t: 'join', code: 'ABCD', name: 'A' });
    conn.send({ t: 'in', s: 1, b: 0 });
    sock.onopen?.();
    sock.onmessage?.({
      data: JSON.stringify({ t: 'welcome', protocolVersion: 3, clientId: 'c', serverTime: 1 }),
    });
    expect(sent.map((d) => (JSON.parse(d) as { t: string }).t)).toEqual(['hello', 'join']);
  });
});

describe('sürüm', () => {
  it('sunucu sürümü el sıkışmada bildirilir', () => {
    let sock!: SocketLike;
    let seen = '';
    connect({
      url: 'ws://x',
      createSocket: () =>
        (sock = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null }),
      onServerVersion: (v) => (seen = v),
    });
    sock.onopen?.();
    sock.onmessage?.({
      data: JSON.stringify({
        t: 'welcome',
        protocolVersion: 3,
        clientId: 'c',
        serverTime: 1,
        version: 'abc1234',
      }),
    });
    expect(seen).toBe('abc1234');
  });
});

describe('başka sunucu sürecine taşınma', () => {
  it('reconnect eski soketi bırakıp adresi yeniden okuyarak hemen bağlanır; eski soketin kapanışı yok sayılır', () => {
    const urls: string[] = [];
    const socks: SocketLike[] = [];
    const statuses: string[] = [];
    let room: string | null = null;
    const conn = connect({
      url: () => `ws://x/ws${room ? `?room=${room}` : ''}`,
      createSocket: (url) => {
        urls.push(url);
        const s: SocketLike = {
          send: () => {},
          close: () => {},
          onopen: null,
          onmessage: null,
          onclose: null,
        };
        socks.push(s);
        return s;
      },
      schedule: () => {
        throw new Error('no backoff for a move');
      },
      onStatus: (s) => statuses.push(s),
    });
    room = 'BCDE';
    conn.reconnect();
    // The old socket closing later must not schedule a retry or flip the status.
    socks[0]!.onclose?.();
    expect(urls).toEqual(['ws://x/ws', 'ws://x/ws?room=BCDE']);
    expect(statuses).toEqual(['connecting', 'connecting']);
    expect(conn.attempts).toBe(0);
  });
});
