import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getAppVersion } from '@server/utils/appVersion';
import { getHostname } from '@server/utils/getHostname';
import { EventEmitter } from 'node:events';

export interface LibraryChangedEvent {
  itemsAdded: string[];
  itemsUpdated: string[];
  itemsRemoved: string[];
  foldersAddedTo: string[];
  foldersRemovedFrom: string[];
  collectionFolders: string[];
}

export type JellyfinSocketMessage =
  | { type: 'forceKeepAlive'; intervalSeconds: number }
  | { type: 'libraryChanged'; event: LibraryChangedEvent };

interface JellyfinSocketEvents {
  connected: [];
  reconnected: [];
  disconnected: [];
  libraryChanged: [LibraryChangedEvent];
}

// Own id so the socket session does not merge with the HTTP API sessions.
const DEVICE_ID = Buffer.from('BOT_seerr_socket').toString('base64');
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

export const parseMessage = (raw: string): JellyfinSocketMessage | null => {
  let msg: { MessageType?: unknown; Data?: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;

  switch (msg.MessageType) {
    case 'ForceKeepAlive':
      return typeof msg.Data === 'number' && msg.Data > 0
        ? { type: 'forceKeepAlive', intervalSeconds: msg.Data }
        : null;
    case 'LibraryChanged': {
      const data = (msg.Data ?? {}) as Record<string, unknown>;
      return {
        type: 'libraryChanged',
        event: {
          itemsAdded: ids(data.ItemsAdded),
          itemsUpdated: ids(data.ItemsUpdated),
          itemsRemoved: ids(data.ItemsRemoved),
          foldersAddedTo: ids(data.FoldersAddedTo),
          foldersRemovedFrom: ids(data.FoldersRemovedFrom),
          collectionFolders: ids(data.CollectionFolders),
        },
      };
    }
    default:
      return null;
  }
};

export interface SocketTarget {
  url: string;
  headers: Record<string, string>;
}

// Header auth: Jellyfin rejects the api_key query parameter while legacy authorization is disabled.
const settingsTarget = (): SocketTarget | undefined => {
  const apiKey = getSettings().jellyfin.apiKey;
  if (!apiKey) return undefined;
  return {
    url: `${getHostname().replace(/^http/, 'ws')}/socket`,
    headers: {
      Authorization: `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="${DEVICE_ID}", Version="${getAppVersion()}", Token="${apiKey}"`,
    },
  };
};

export class JellyfinSocket extends EventEmitter<JellyfinSocketEvents> {
  private socket?: WebSocket;
  private keepAlive?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private backoff = MIN_BACKOFF_MS;
  private running = false;
  private everConnected = false;

  constructor(
    private readonly getTarget: () => SocketTarget | undefined = settingsTarget
  ) {
    super();
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  public stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.teardown();
  }

  private connect(): void {
    const target = this.getTarget();
    if (!target) {
      logger.warn('No Jellyfin API key configured, websocket not started', {
        label: 'Jellyfin Socket',
      });
      this.running = false;
      return;
    }

    // Node's WebSocket (undici) takes headers in a second argument the DOM typings do not know.
    const socket = new WebSocket(target.url, {
      headers: target.headers,
    } as unknown as string[]);
    this.socket = socket;
    let opened = false;

    socket.onopen = () => {
      opened = true;
      this.backoff = MIN_BACKOFF_MS;
      logger.info('Connected', { label: 'Jellyfin Socket' });
      this.emit(this.everConnected ? 'reconnected' : 'connected');
      this.everConnected = true;
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.handle(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.teardown();
      logger.debug('Closed', {
        label: 'Jellyfin Socket',
        code: event.code,
        reason: event.reason,
      });
      if (opened) this.emit('disconnected');
      this.scheduleReconnect();
    };
    // Node fires close after error, reconnect is handled there.
    socket.onerror = () => undefined;
  }

  private handle(raw: string): void {
    const msg = parseMessage(raw);
    if (!msg) return;

    if (msg.type === 'forceKeepAlive') {
      clearInterval(this.keepAlive);
      this.keepAlive = setInterval(
        () => this.socket?.send(JSON.stringify({ MessageType: 'KeepAlive' })),
        (msg.intervalSeconds * 1000) / 2
      );
      return;
    }

    this.emit('libraryChanged', msg.event);
  }

  private teardown(): void {
    clearInterval(this.keepAlive);
    this.keepAlive = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) this.connect();
    }, delay);
  }
}

const jellyfinSocket = new JellyfinSocket();

export default jellyfinSocket;
