import { getMetadataProvider } from '@server/api/metadata';
import { isNotFound } from '@server/api/servarr/base';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type {
  TmdbKeyword,
  TmdbTvDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type {
  ProcessableSeason,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

type SyncStatus = StatusBase & {
  currentServer: SonarrSettings;
  servers: SonarrSettings[];
};

class SonarrScanner
  extends BaseScanner<SonarrSeries>
  implements RunnableScanner<SyncStatus>
{
  protected declineRequestsOnStatusReset = true;
  private servers: SonarrSettings[];
  private currentServer: SonarrSettings;
  private sonarrApi: SonarrAPI;
  private scannedTvdbIds: Set<number> = new Set();
  private scanned4kTvdbIds: Set<number> = new Set();
  // Keyed on tmdbId: media.tvdbId can be null. Excludes unmonitored titles.
  private processingTmdbIds: Set<number> = new Set();
  private processing4kTmdbIds: Set<number> = new Set();
  private didScanStandard = false;
  private didScan4k = false;
  private serverReturnedEmpty = false;
  private server4kReturnedEmpty = false;

  constructor() {
    super('Sonarr Scan', { bundleSize: 50 });
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
      servers: this.servers,
    };
  }

  public async run(): Promise<void> {
    const settings = getSettings();
    const sessionId = this.startRun();
    this.scannedTvdbIds.clear();
    this.scanned4kTvdbIds.clear();
    this.processingTmdbIds.clear();
    this.processing4kTmdbIds.clear();
    this.didScanStandard = false;
    this.didScan4k = false;
    this.serverReturnedEmpty = false;
    this.server4kReturnedEmpty = false;

    try {
      this.servers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
        return (
          sonarrA.hostname === sonarrB.hostname &&
          sonarrA.port === sonarrB.port &&
          sonarrA.baseUrl === sonarrB.baseUrl
        );
      });

      for (const server of this.servers) {
        this.currentServer = server;
        if (server.syncEnabled) {
          this.log(
            `Beginning to process Sonarr server: ${server.name}`,
            'info'
          );

          this.sonarrApi = sonarrApi(server);

          this.items = await this.sonarrApi.getSeries();

          const server4k = this.enable4kShow && server.is4k;
          if (server4k) {
            this.didScan4k = true;
          } else {
            this.didScanStandard = true;
          }

          if (this.items.length === 0) {
            if (server4k) {
              this.server4kReturnedEmpty = true;
            } else {
              this.serverReturnedEmpty = true;
            }
            this.log(
              `Sonarr server ${server.name} returned no series. Orphan cleanup for this profile type will be skipped.`,
              'warn'
            );
          }

          await this.loop(this.processSonarrSeries.bind(this), { sessionId });
        } else {
          this.log(`Sync not enabled. Skipping Sonarr server: ${server.name}`);
        }
      }

      // Only run cleanup if all servers of this profile type have sync enabled.
      // If any server is skipped, we can't distinguish truly orphaned media from
      // media that exists on an unscanned server (e.g. separate instances for
      // anime, regional content, or different languages).
      const allStandardScanned = this.servers
        .filter((s) => !this.enable4kShow || !s.is4k)
        .every((s) => s.syncEnabled);
      const all4kScanned = this.servers
        .filter((s) => this.enable4kShow && s.is4k)
        .every((s) => s.syncEnabled);

      if (!allStandardScanned) {
        this.didScanStandard = false;
      }
      if (!all4kScanned) {
        this.didScan4k = false;
      }

      if (this.serverReturnedEmpty) {
        this.didScanStandard = false;
      }
      if (this.server4kReturnedEmpty) {
        this.didScan4k = false;
      }

      await this.resolveStatusResets((media, is4k) => {
        const scanComplete = is4k ? this.didScan4k : this.didScanStandard;
        const processingIds = is4k
          ? this.processing4kTmdbIds
          : this.processingTmdbIds;

        return scanComplete && !processingIds.has(media.tmdbId);
      });

      await this.cleanupOrphanedShows();
      this.log('Sonarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);
    }
  }

  /**
   * Processes one series Seerr links to a Sonarr series, as the scan would, e.g. after a Sonarr
   * event. A series gone from that server and from every other one of its profile type is handled
   * as the orphan cleanup handles it.
   */
  public async syncSeries(serverId: number, sonarrSeriesId: number) {
    const settings = getSettings();
    const server = settings.sonarr.find((s) => s.id === serverId);
    if (!server?.syncEnabled) return;
    this.enable4kShow = settings.sonarr.some((s) => s.is4k);
    const is4k = this.enable4kShow && server.is4k;
    const media = await getRepository(Media).findOne({
      where: is4k
        ? {
            mediaType: MediaType.TV,
            serviceId4k: serverId,
            externalServiceId4k: sonarrSeriesId,
          }
        : {
            mediaType: MediaType.TV,
            serviceId: serverId,
            externalServiceId: sonarrSeriesId,
          },
      relations: { seasons: true },
    });
    if (!media) return;

    try {
      const series = await sonarrApi(server).getSeriesById(sonarrSeriesId);
      return this.processSonarrSeries(series, server);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }

    const others = settings.sonarr.filter(
      (s) => s.id !== serverId && (this.enable4kShow && s.is4k) === is4k
    );
    // As in the orphan cleanup: a server not synced may hold the series.
    if (!media.tvdbId || others.some((s) => !s.syncEnabled)) return;
    for (const other of others) {
      const series = await sonarrApi(other)
        .getSeriesByTvdbId(media.tvdbId)
        .catch((e: Error) => {
          if (e.message === 'Series not found') return undefined;
          throw e;
        });
      if (series?.id) return this.processSonarrSeries(series, other);
    }
    await this.resetOrphanedShow(media, is4k);
  }

  private async processSonarrSeries(
    sonarrSeries: SonarrSeries,
    server = this.currentServer
  ) {
    const server4k = this.enable4kShow && server.is4k;
    if (server4k) {
      this.scanned4kTvdbIds.add(sonarrSeries.tvdbId);
    } else {
      this.scannedTvdbIds.add(sonarrSeries.tvdbId);
    }

    try {
      const mediaRepository = getRepository(Media);
      const processableSeasons: ProcessableSeason[] = [];
      let tvShow: TmdbTvScanDetails | TmdbTvDetails;

      const media = await mediaRepository.findOne({
        where: { tvdbId: sonarrSeries.tvdbId },
      });

      if (!media || !media.tmdbId) {
        tvShow = await this.tmdb.getShowByTvdbIdForScan({
          tvdbId: sonarrSeries.tvdbId,
        });
      } else {
        tvShow = await this.tmdb.getTvShowForScan({ tvId: media.tmdbId });
      }

      if (media) {
        await this.failUnfulfillableRequests(media, server4k, {
          seasons: sonarrSeries.seasons.map((s) => ({
            seasonNumber: s.seasonNumber,
            monitored: s.monitored,
            episodeFileCount: s.statistics?.episodeFileCount ?? 0,
          })),
        });
      }

      const tmdbId = tvShow.id;
      const metadataProvider = tvShow.keywords.results.some(
        (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
      )
        ? await getMetadataProvider('anime')
        : await getMetadataProvider('tv');

      if (!(metadataProvider instanceof TheMovieDb)) {
        tvShow = await metadataProvider.getTvShow({ tvId: tmdbId });
      }

      const settings = getSettings();

      const filteredSeasons = tvShow.seasons
        .filter(
          (sn) => settings.main.enableSpecialEpisodes || sn.season_number !== 0
        )
        .map((season) => {
          const sonarrSeason = sonarrSeries.seasons.find(
            (s) => s.seasonNumber === season.season_number
          );
          if (!sonarrSeason) {
            return {
              seasonNumber: season.season_number,
              episodeCount: season.episode_count,
              monitored: false,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: season.episode_count,
              },
            };
          } else {
            return sonarrSeason;
          }
        });

      for (const season of filteredSeasons) {
        const totalAvailableEpisodes = season.statistics?.episodeFileCount ?? 0;

        processableSeasons.push({
          seasonNumber: season.seasonNumber,
          episodes: !server4k ? totalAvailableEpisodes : 0,
          episodes4k: server4k ? totalAvailableEpisodes : 0,
          totalEpisodes: season.statistics?.totalEpisodeCount ?? 0,
          processing: season.monitored && totalAvailableEpisodes === 0,
          is4kOverride: server4k,
        });
      }

      if (processableSeasons.some((season) => season.processing)) {
        if (server4k) {
          this.processing4kTmdbIds.add(tmdbId);
        } else {
          this.processingTmdbIds.add(tmdbId);
        }
      }

      await this.processShow(tmdbId, sonarrSeries.tvdbId, processableSeasons, {
        serviceId: server.id,
        externalServiceId: sonarrSeries.id,
        externalServiceSlug: sonarrSeries.titleSlug,
        title: sonarrSeries.title,
        is4k: server4k,
      });
    } catch (e) {
      this.log('Failed to process Sonarr media', 'error', {
        errorMessage: e.message,
        title: sonarrSeries.title,
      });
    }
  }

  private async existsInAnyServer(
    tvdbId: number,
    is4k: boolean
  ): Promise<boolean> {
    const servers = this.servers.filter(
      (server) =>
        server.syncEnabled && (this.enable4kShow && server.is4k) === is4k
    );

    for (const server of servers) {
      try {
        const api = new SonarrAPI({
          apiKey: server.apiKey,
          url: SonarrAPI.buildUrl(server, '/api/v3'),
        });
        const series = await api.getLibrarySeriesByTvdbId(tvdbId);

        if (series.some((show) => show.tvdbId === tvdbId)) {
          return true;
        }
      } catch (e) {
        this.log(
          `Could not confirm series ${tvdbId} against Sonarr server ${server.name}. Skipping cleanup for it.`,
          'warn',
          { errorMessage: e.message }
        );
        return true;
      }
    }

    return false;
  }

  /** For a show no Sonarr server of its profile type has; needs the seasons relation. */
  private async resetOrphanedShow(media: Media, is4k: boolean) {
    const statusKey = is4k ? 'status4k' : 'status';
    if (media[statusKey] !== MediaStatus.PROCESSING) return;
    await this.failUnfulfillableRequests(media, is4k, null);
    media[statusKey] = MediaStatus.UNKNOWN;
    for (const season of media.seasons) {
      if (season[statusKey] === MediaStatus.PROCESSING) {
        season[statusKey] = MediaStatus.UNKNOWN;
      }
    }
    await getRepository(Media).save(media);
    this.log(
      `Show ${media.tmdbId} (tvdb: ${media.tvdbId}) not found in any ${is4k ? '4K ' : ''}Sonarr server. ${is4k ? '4K status' : 'Status'} reset to UNKNOWN.`,
      'info'
    );
  }

  private async cleanupOrphanedShows(): Promise<void> {
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      const processingShows = await mediaRepository.find({
        where: { mediaType: MediaType.TV, status: MediaStatus.PROCESSING },
        relations: { seasons: true },
      });

      for (const media of processingShows) {
        if (media.tvdbId && !this.scannedTvdbIds.has(media.tvdbId)) {
          if (await this.existsInAnyServer(media.tvdbId, false)) {
            continue;
          }

          await this.resetOrphanedShow(media, false);
        }
      }
    } else {
      this.log(
        'Skipping orphaned show cleanup: no standard Sonarr servers were scanned.',
        'info'
      );
    }

    if (this.didScan4k) {
      const processing4kShows = await mediaRepository.find({
        where: { mediaType: MediaType.TV, status4k: MediaStatus.PROCESSING },
        relations: { seasons: true },
      });

      for (const media of processing4kShows) {
        if (media.tvdbId && !this.scanned4kTvdbIds.has(media.tvdbId)) {
          if (await this.existsInAnyServer(media.tvdbId, true)) {
            continue;
          }

          await this.resetOrphanedShow(media, true);
        }
      }
    } else if (this.enable4kShow) {
      this.log(
        'Skipping orphaned 4K show cleanup: no 4K Sonarr servers were scanned.',
        'info'
      );
    }
  }
}

const sonarrApi = (server: SonarrSettings) =>
  new SonarrAPI({
    apiKey: server.apiKey,
    url: SonarrAPI.buildUrl(server, '/api/v3'),
  });

export const sonarrScanner = new SonarrScanner();
