import type { HubConnection, ILogger } from '@microsoft/signalr';
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import ServarrBase from '@server/api/servarr/base';
import type { DVRSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { EventEmitter } from 'node:events';

export type ServarrType = 'radarr' | 'sonarr';

export type CommandStatus =
  | 'queued'
  | 'started'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'cancelled'
  | 'orphaned';

export type ResourceAction = 'updated' | 'deleted';

export interface CommandEvent {
  type: 'command';
  id: number;
  name: string;
  status: CommandStatus;
  // 'successful' or 'unsuccessful'; a search that found nothing still completes.
  result?: string;
  message?: string;
  /** 'manual' for user and API searches; 'unspecified' for e.g. a re-search after a failed download. */
  trigger?: string;
  /** Grabbed releases, from the message of a completed search; 0 means no results. */
  reportsDownloaded?: number;
  movieIds?: number[];
  seriesId?: number;
  seasonNumber?: number;
  episodeIds?: number[];
}

export type ServarrSignalREvent =
  | CommandEvent
  // The queue messages carry no usable diff, only the hint to refetch.
  | { type: 'queue' }
  | { type: 'movie'; action: ResourceAction; id: number; tmdbId?: number }
  | { type: 'series'; action: ResourceAction; id: number; tvdbId?: number }
  | { type: 'movieFile'; action: ResourceAction; id: number; movieId?: number }
  // The only link from a Sonarr episode to its series; episode searches carry episode ids only.
  | {
      type: 'episode';
      action: ResourceAction;
      id: number;
      seriesId?: number;
      episodeFileId?: number;
      hasFile?: boolean;
    }
  | {
      type: 'episodeFile';
      action: ResourceAction;
      id: number;
      seriesId?: number;
      seasonNumber?: number;
    };

const COMMAND_STATUSES: readonly string[] = [
  'queued',
  'started',
  'completed',
  'failed',
  'aborted',
  'cancelled',
  'orphaned',
];

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Obj)
    : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;
const nums = (v: unknown): number[] | undefined =>
  Array.isArray(v) && v.every((n) => num(n) !== undefined)
    ? (v as number[])
    : undefined;
const action = (v: unknown): ResourceAction | undefined =>
  v === 'updated' || v === 'deleted' ? v : undefined;

/**
 * Parses one `receiveMessage` payload ({name, body: {action, resource}}).
 * Returns undefined for anything unknown or malformed.
 */
export function parseSignalRMessage(
  message: unknown
): ServarrSignalREvent | undefined {
  const name = str(obj(message)?.name);
  const body = obj(obj(message)?.body);
  if (!name || !body) return undefined;

  if (name === 'queue' || name === 'queue/status' || name === 'queue/details') {
    return { type: 'queue' };
  }

  const resource = obj(body.resource);
  const id = num(resource?.id);
  if (!resource || id === undefined) return undefined;

  if (name === 'command') {
    const cmdName = str(resource.name);
    const status = str(resource.status);
    if (
      !cmdName?.endsWith('Search') ||
      !COMMAND_STATUSES.includes(status ?? '')
    ) {
      return undefined;
    }
    const cmdBody = obj(resource.body);
    const message = str(resource.message);
    // Sonarr sends a completed-looking message while the command is still started.
    const reports =
      status === 'completed'
        ? message?.match(/(\d+) reports? downloaded/)?.[1]
        : undefined;
    return {
      type: 'command',
      id,
      name: cmdName,
      status: status as CommandStatus,
      result: str(resource.result),
      message,
      trigger: str(resource.trigger) ?? str(cmdBody?.trigger),
      reportsDownloaded: reports === undefined ? undefined : Number(reports),
      movieIds: nums(cmdBody?.movieIds),
      seriesId: num(cmdBody?.seriesId),
      seasonNumber: num(cmdBody?.seasonNumber),
      episodeIds: nums(cmdBody?.episodeIds),
    };
  }

  const act = action(body.action);
  if (!act) return undefined;

  switch (name) {
    case 'movie':
      return { type: 'movie', action: act, id, tmdbId: num(resource.tmdbId) };
    case 'series':
      return { type: 'series', action: act, id, tvdbId: num(resource.tvdbId) };
    case 'episode':
      return {
        type: 'episode',
        action: act,
        id,
        seriesId: num(resource.seriesId),
        episodeFileId: num(resource.episodeFileId),
        hasFile:
          typeof resource.hasFile === 'boolean' ? resource.hasFile : undefined,
      };
    case 'moviefile':
      return {
        type: 'movieFile',
        action: act,
        id,
        movieId: num(resource.movieId),
      };
    case 'episodefile':
      return {
        type: 'episodeFile',
        action: act,
        id,
        seriesId: num(resource.seriesId),
        seasonNumber: num(resource.seasonNumber),
      };
    default:
      return undefined;
  }
}

export const retryDelayMs = (attempt: number): number =>
  Math.min(1000 * 2 ** attempt, 60_000);

// The library logs every failed retry at warning level; the client logs state changes itself.
// Its messages include the connection URL, which carries the API key.
const signalRLogger = (label: string, apiKey: string): ILogger => ({
  log(level, message) {
    if (level >= LogLevel.Information) {
      logger.debug(message.replaceAll(apiKey, '<apiKey>'), { label });
    }
  },
});

interface ClientEvents {
  connected: [];
  reconnected: [];
  disconnected: [];
  message: [ServarrSignalREvent];
}

export class ServarrSignalRClient extends EventEmitter<ClientEvents> {
  private connection: HubConnection;
  private stopped = false;
  private retryTimer?: NodeJS.Timeout;
  private label: string;

  constructor(
    public readonly type: ServarrType,
    public readonly settings: DVRSettings
  ) {
    super();
    this.label = `${type === 'radarr' ? 'Radarr' : 'Sonarr'} SignalR (${settings.name})`;
    // Servarr's API key handler reads access_token from the query, as its own web UI sends it.
    const url = `${ServarrBase.buildUrl(settings, '/signalr/messages')}?access_token=${encodeURIComponent(settings.apiKey)}`;
    this.connection = new HubConnectionBuilder()
      .withUrl(url)
      // Never give up: the default policy stops after four attempts.
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) =>
          retryDelayMs(ctx.previousRetryCount),
      })
      .configureLogging(signalRLogger(this.label, settings.apiKey))
      .build();

    this.connection.on('receiveMessage', (raw: unknown) => {
      const event = parseSignalRMessage(raw);
      if (event) this.emit('message', event);
    });
    this.connection.onreconnecting((e) => {
      logger.warn(`Connection lost: ${e?.message ?? 'unknown'}`, {
        label: this.label,
      });
      this.emit('disconnected');
    });
    this.connection.onreconnected(() => this.emit('reconnected'));
    this.connection.onclose(() => {
      if (this.stopped) return;
      this.emit('disconnected');
      this.connect();
    });
  }

  public start(): void {
    this.stopped = false;
    this.connect();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    await this.connection.stop();
  }

  // withAutomaticReconnect only covers connections that were up once; the first start retries here.
  private connect(attempt = 0): void {
    this.connection.start().then(
      () => {
        if (this.stopped) return void this.connection.stop();
        logger.info('Connected', { label: this.label });
        this.emit('connected');
      },
      (e: Error) => {
        if (this.stopped) return;
        const delay = retryDelayMs(attempt);
        logger.debug(`Connect failed, retrying in ${delay}ms: ${e.message}`, {
          label: this.label,
        });
        this.retryTimer = setTimeout(() => this.connect(attempt + 1), delay);
      }
    );
  }
}

export interface SignalRSource {
  type: ServarrType;
  serverId: number;
}

interface ManagerEvents {
  connected: [SignalRSource];
  reconnected: [SignalRSource];
  disconnected: [SignalRSource];
  message: [SignalRSource, ServarrSignalREvent];
}

const connectionKey = (s: DVRSettings) =>
  `${ServarrBase.buildUrl(s, '')}|${s.apiKey}`;

/**
 * One client per configured Radarr/Sonarr server. Listeners attach to the
 * manager, so they survive clients being rebuilt by sync().
 */
class ServarrSignalRManager extends EventEmitter<ManagerEvents> {
  private clients = new Map<string, ServarrSignalRClient>();
  private running = false;

  public start(): void {
    this.running = true;
    this.sync();
  }

  public async stop(): Promise<void> {
    this.running = false;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.stop()));
  }

  /** Reconciles clients with the current settings; call after a settings change. */
  public sync(): void {
    if (!this.running) return;
    const settings = getSettings();
    const wanted = new Map<string, [ServarrType, DVRSettings]>();
    for (const s of settings.radarr)
      wanted.set(`radarr:${s.id}`, ['radarr', s]);
    for (const s of settings.sonarr)
      wanted.set(`sonarr:${s.id}`, ['sonarr', s]);

    for (const [key, client] of this.clients) {
      const next = wanted.get(key);
      if (!next || connectionKey(next[1]) !== connectionKey(client.settings)) {
        this.clients.delete(key);
        client.removeAllListeners();
        void client.stop();
      }
    }

    for (const [key, [type, s]] of wanted) {
      if (this.clients.has(key)) continue;
      const client = new ServarrSignalRClient(type, { ...s });
      const source: SignalRSource = { type, serverId: s.id };
      client.on('connected', () => this.emit('connected', source));
      client.on('reconnected', () => this.emit('reconnected', source));
      client.on('disconnected', () => this.emit('disconnected', source));
      client.on('message', (e) => this.emit('message', source, e));
      this.clients.set(key, client);
      client.start();
    }
  }
}

export const servarrSignalR = new ServarrSignalRManager();
