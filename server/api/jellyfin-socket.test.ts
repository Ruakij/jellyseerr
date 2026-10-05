import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { JellyfinSocket, parseMessage } from '@server/api/jellyfin-socket';

describe('parseMessage', () => {
  it('parses LibraryChanged into item id lists', () => {
    const msg = parseMessage(
      JSON.stringify({
        MessageType: 'LibraryChanged',
        MessageId: 'x',
        Data: {
          ItemsAdded: ['a1', 'a2'],
          ItemsUpdated: ['u1'],
          ItemsRemoved: [],
          FoldersAddedTo: ['f1'],
          FoldersRemovedFrom: [],
          CollectionFolders: ['c1'],
          IsEmpty: false,
        },
      })
    );
    assert.deepStrictEqual(msg, {
      type: 'libraryChanged',
      event: {
        itemsAdded: ['a1', 'a2'],
        itemsUpdated: ['u1'],
        itemsRemoved: [],
        foldersAddedTo: ['f1'],
        foldersRemovedFrom: [],
        collectionFolders: ['c1'],
      },
    });
  });

  it('defaults missing or malformed id lists to empty', () => {
    const msg = parseMessage(
      JSON.stringify({
        MessageType: 'LibraryChanged',
        Data: { ItemsAdded: 'nope', ItemsUpdated: [1, 'u1'] },
      })
    );
    assert.deepStrictEqual(msg, {
      type: 'libraryChanged',
      event: {
        itemsAdded: [],
        itemsUpdated: ['u1'],
        itemsRemoved: [],
        foldersAddedTo: [],
        foldersRemovedFrom: [],
        collectionFolders: [],
      },
    });
  });

  it('parses ForceKeepAlive', () => {
    assert.deepStrictEqual(
      parseMessage('{"MessageType":"ForceKeepAlive","Data":60}'),
      { type: 'forceKeepAlive', intervalSeconds: 60 }
    );
    assert.strictEqual(
      parseMessage('{"MessageType":"ForceKeepAlive","Data":0}'),
      null
    );
  });

  it('ignores unknown types and invalid json', () => {
    assert.strictEqual(parseMessage('{"MessageType":"KeepAlive"}'), null);
    assert.strictEqual(parseMessage('{"MessageType":"Sessions"}'), null);
    assert.strictEqual(parseMessage('not json'), null);
    assert.strictEqual(parseMessage('null'), null);
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' });
  }
}

describe('JellyfinSocket', () => {
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    Object.assign(FakeWebSocket, { CONNECTING: 0, OPEN: 1, CLOSED: 3 });
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.WebSocket = realWebSocket;
  });

  const startSocket = () => {
    const client = new JellyfinSocket(() => ({
      url: 'ws://jf/socket',
      headers: {},
    }));
    client.start();
    return client;
  };

  it('sends KeepAlive at half the ForceKeepAlive interval', () => {
    const client = startSocket();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.message({ MessageType: 'ForceKeepAlive', Data: 60 });

    mock.timers.tick(29_999);
    assert.strictEqual(ws.sent.length, 0);
    mock.timers.tick(1);
    assert.deepStrictEqual(ws.sent, ['{"MessageType":"KeepAlive"}']);
    mock.timers.tick(30_000);
    assert.strictEqual(ws.sent.length, 2);

    client.stop();
    mock.timers.tick(60_000);
    assert.strictEqual(ws.sent.length, 2);
  });

  it('emits libraryChanged events', () => {
    const client = startSocket();
    const ws = FakeWebSocket.instances[0];
    const events: unknown[] = [];
    client.on('libraryChanged', (e) => events.push(e));
    ws.open();
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ['a'] } });
    ws.message({ MessageType: 'Unknown', Data: {} });

    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual((events[0] as { itemsAdded: string[] }).itemsAdded, [
      'a',
    ]);
    client.stop();
  });

  it('reconnects with backoff and emits lifecycle events', () => {
    const client = startSocket();
    const events: string[] = [];
    for (const name of ['connected', 'reconnected', 'disconnected'] as const) {
      client.on(name, () => events.push(name));
    }

    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].drop();
    mock.timers.tick(1000);
    assert.strictEqual(FakeWebSocket.instances.length, 2);

    // failed attempt without open: no disconnected event, backoff doubles
    FakeWebSocket.instances[1].drop();
    mock.timers.tick(1999);
    assert.strictEqual(FakeWebSocket.instances.length, 2);
    mock.timers.tick(1);
    assert.strictEqual(FakeWebSocket.instances.length, 3);

    FakeWebSocket.instances[2].open();
    assert.deepStrictEqual(events, [
      'connected',
      'disconnected',
      'reconnected',
    ]);

    client.stop();
    mock.timers.tick(120_000);
    assert.strictEqual(FakeWebSocket.instances.length, 3);
  });
});
