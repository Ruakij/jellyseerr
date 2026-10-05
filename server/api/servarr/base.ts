import ExternalAPI from '@server/api/externalapi';
import type { AvailableCacheIds } from '@server/lib/cache';
import cacheManager from '@server/lib/cache';
import { getSettings, type DVRSettings } from '@server/lib/settings';

export interface SystemStatus {
  version: string;
  buildTime: Date;
  isDebug: boolean;
  isProduction: boolean;
  isAdmin: boolean;
  isUserInteractive: boolean;
  startupPath: string;
  appData: string;
  osName: string;
  osVersion: string;
  isNetCore: boolean;
  isMono: boolean;
  isLinux: boolean;
  isOsx: boolean;
  isWindows: boolean;
  isDocker: boolean;
  mode: string;
  branch: string;
  authentication: string;
  sqliteVersion: string;
  migrationVersion: number;
  urlBase: string;
  runtimeVersion: string;
  runtimeName: string;
  startTime: Date;
  packageUpdateMechanism: string;
}

export interface RootFolder {
  id: number;
  path: string;
  freeSpace: number;
  totalSpace: number;
  unmappedFolders: {
    name: string;
    path: string;
  }[];
}

export interface QualityProfile {
  id: number;
  name: string;
}

interface QueueItem {
  size: number;
  title: string;
  sizeleft: number;
  timeleft: string;
  estimatedCompletionTime: string;
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  downloadId: string;
  protocol: string;
  downloadClient: string;
  indexer: string;
  id: number;
}

export interface Tag {
  id: number;
  label: string;
}

interface QueueResponse<QueueItemAppendT> {
  page: number;
  pageSize: number;
  sortKey: string;
  sortDirection: string;
  totalRecords: number;
  records: (QueueItem & QueueItemAppendT)[];
}

export type HistoryEventType =
  | 'unknown'
  | 'grabbed'
  | 'downloadFolderImported'
  | 'downloadFailed'
  | 'downloadIgnored'
  | 'movieFolderImported'
  | 'movieFileDeleted'
  | 'movieFileRenamed'
  | 'seriesFolderImported'
  | 'episodeFileDeleted'
  | 'episodeFileRenamed';

// Radarr and Sonarr number their history enums differently; these three share their values.
const HISTORY_EVENT_TYPE_IDS = {
  grabbed: 1,
  downloadFolderImported: 3,
  downloadFailed: 4,
} as const;

const HISTORY_SINCE_PAGE_SIZE = 250;

export type HistoryEventTypeFilter = keyof typeof HISTORY_EVENT_TYPE_IDS;

export interface HistoryRecord {
  id: number;
  date: string;
  eventType: HistoryEventType;
  sourceTitle: string;
  // Shared by the grabbed and the import records of one download; absent for manual imports.
  downloadId?: string;
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
  // Sonarr only, requested with includeEpisode.
  episode?: { seasonNumber: number; episodeNumber: number };
  data: Record<string, string | undefined>;
}

interface HistoryResponse {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: HistoryRecord[];
}

/** The request failed with a 404, i.e. the item does not exist in Radarr/Sonarr. */
export const isNotFound = (e: Error) =>
  (e.cause as { response?: { status?: number } } | undefined)?.response
    ?.status === 404;

class ServarrBase<QueueItemAppendT> extends ExternalAPI {
  static buildUrl(settings: DVRSettings, path?: string): string {
    return `${settings.useSsl ? 'https' : 'http'}://${settings.hostname}:${
      settings.port
    }${settings.baseUrl ?? ''}${path}`;
  }

  protected apiName: string;

  constructor({
    url,
    apiKey,
    cacheName,
    apiName,
  }: {
    url: string;
    apiKey: string;
    cacheName: AvailableCacheIds;
    apiName: string;
  }) {
    const timeout = getSettings().network.apiRequestTimeout;

    super(
      url,
      {
        apikey: apiKey,
      },
      {
        nodeCache: cacheManager.getCache(cacheName).data,
        timeout,
      }
    );

    this.apiName = apiName;
  }

  public getSystemStatus = async (): Promise<SystemStatus> => {
    try {
      const response = await this.axios.get<SystemStatus>('/system/status');

      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve system status: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getProfiles = async (): Promise<QualityProfile[]> => {
    try {
      const data = await this.getRolling<QualityProfile[]>(
        `/qualityProfile`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve profiles: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getRootFolders = async (): Promise<RootFolder[]> => {
    try {
      const data = await this.getRolling<RootFolder[]>(
        `/rootfolder`,
        undefined,
        3600
      );

      return data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve root folders: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getQueue = async (): Promise<(QueueItem & QueueItemAppendT)[]> => {
    try {
      const response = await this.axios.get<QueueResponse<QueueItemAppendT>>(
        `/queue`,
        {
          params: {
            includeEpisode: true,
          },
        }
      );

      return response.data.records;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve queue: ${e.message}`,
        { cause: e }
      );
    }
  };

  /**
   * Newest records first. With `since`, pages are read until a record is older than that date or
   * `limit` records were read; the `/history/since` endpoint is unpaged and times out on large
   * histories.
   */
  public getHistory = async ({
    eventType,
    since,
    limit,
    page = 1,
    pageSize = 200,
  }: {
    eventType?: HistoryEventTypeFilter;
    since?: Date;
    limit?: number;
    page?: number;
    pageSize?: number;
  } = {}): Promise<HistoryRecord[]> => {
    const eventTypeId = eventType && HISTORY_EVENT_TYPE_IDS[eventType];
    const getPage = async (page: number, pageSize: number) => {
      const response = await this.axios.get<HistoryResponse>('/history', {
        params: {
          page,
          pageSize,
          sortKey: 'date',
          sortDirection: 'descending',
          eventType: eventTypeId,
          includeEpisode: true,
        },
      });
      return response.data;
    };
    try {
      if (!since) return (await getPage(page, pageSize)).records;

      const oldest = since.getTime();
      const records: HistoryRecord[] = [];
      for (let next = 1; ; next++) {
        const data = await getPage(next, HISTORY_SINCE_PAGE_SIZE);
        for (const record of data.records) {
          if (Date.parse(record.date) < oldest) return records;
          records.push(record);
          if (limit && records.length >= limit) return records;
        }
        if (next * HISTORY_SINCE_PAGE_SIZE >= data.totalRecords) return records;
      }
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve history: ${e.message}`,
        { cause: e }
      );
    }
  };

  /** All records of one Radarr movie or Sonarr series. */
  public getItemHistory = async (id: number): Promise<HistoryRecord[]> => {
    const [path, param] =
      this.apiName === 'Radarr'
        ? ['/history/movie', 'movieId']
        : ['/history/series', 'seriesId'];
    try {
      const response = await this.axios.get<HistoryRecord[]>(path, {
        params: { [param]: id, includeEpisode: true },
      });
      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve history: ${e.message}`,
        { cause: e }
      );
    }
  };

  public getTags = async (): Promise<Tag[]> => {
    try {
      const response = await this.axios.get<Tag[]>(`/tag`);

      return response.data;
    } catch (e) {
      throw new Error(
        `[${this.apiName}] Failed to retrieve tags: ${e.message}`,
        { cause: e }
      );
    }
  };

  public createTag = async ({ label }: { label: string }): Promise<Tag> => {
    try {
      const response = await this.axios.post<Tag>(`/tag`, {
        label,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to create tag: ${e.message}`, {
        cause: e,
      });
    }
  };

  public renameTag = async ({
    id,
    label,
  }: {
    id: number;
    label: string;
  }): Promise<Tag> => {
    try {
      const response = await this.axios.put<Tag>(`/tag/${id}`, {
        id,
        label,
      });

      return response.data;
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to rename tag: ${e.message}`, {
        cause: e,
      });
    }
  };

  async refreshMonitoredDownloads(): Promise<void> {
    await this.runCommand('RefreshMonitoredDownloads', {});
  }

  public async runCommand(
    commandName: string,
    options: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.axios.post(`/command`, {
        name: commandName,
        ...options,
      });
    } catch (e) {
      throw new Error(`[${this.apiName}] Failed to run command: ${e.message}`, {
        cause: e,
      });
    }
  }
}

export default ServarrBase;
