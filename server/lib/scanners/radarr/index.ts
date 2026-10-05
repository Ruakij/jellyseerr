import { isNotFound } from '@server/api/servarr/base';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

type SyncStatus = StatusBase & {
  currentServer: RadarrSettings;
  servers: RadarrSettings[];
};

class RadarrScanner
  extends BaseScanner<RadarrMovie>
  implements RunnableScanner<SyncStatus>
{
  protected declineRequestsOnStatusReset = true;
  private servers: RadarrSettings[];
  private currentServer: RadarrSettings;
  private radarrApi: RadarrAPI;
  private scannedTmdbIds: Set<number> = new Set();
  private scanned4kTmdbIds: Set<number> = new Set();
  // Distinct from the scanned sets, which also include unmonitored titles.
  private processingTmdbIds: Set<number> = new Set();
  private processing4kTmdbIds: Set<number> = new Set();
  private didScanStandard = false;
  private didScan4k = false;
  private serverReturnedEmpty = false;
  private server4kReturnedEmpty = false;

  constructor() {
    super('Radarr Scan', { bundleSize: 50 });
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
    this.scannedTmdbIds.clear();
    this.scanned4kTmdbIds.clear();
    this.processingTmdbIds.clear();
    this.processing4kTmdbIds.clear();
    this.didScanStandard = false;
    this.didScan4k = false;
    this.serverReturnedEmpty = false;
    this.server4kReturnedEmpty = false;

    try {
      this.servers = uniqWith(settings.radarr, (radarrA, radarrB) => {
        return (
          radarrA.hostname === radarrB.hostname &&
          radarrA.port === radarrB.port &&
          radarrA.baseUrl === radarrB.baseUrl
        );
      });

      for (const server of this.servers) {
        this.currentServer = server;
        if (server.syncEnabled) {
          this.log(
            `Beginning to process Radarr server: ${server.name}`,
            'info'
          );

          this.radarrApi = radarrApi(server);

          this.items = await this.radarrApi.getMovies();

          const server4k = this.enable4kMovie && server.is4k;
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
              `Radarr server ${server.name} returned no movies. Orphan cleanup for this profile type will be skipped.`,
              'warn'
            );
          }

          await this.loop(this.processRadarrMovie.bind(this), { sessionId });
        } else {
          this.log(`Sync not enabled. Skipping Radarr server: ${server.name}`);
        }
      }

      // Only run cleanup if all servers of this profile type have sync enabled.
      // If any server is skipped, we can't distinguish truly orphaned media from
      // media that exists on an unscanned server (e.g. separate instances for
      // anime, regional content, or different languages).
      const allStandardScanned = this.servers
        .filter((s) => !this.enable4kMovie || !s.is4k)
        .every((s) => s.syncEnabled);
      const all4kScanned = this.servers
        .filter((s) => this.enable4kMovie && s.is4k)
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

      await this.cleanupOrphanedMovies();
      this.log('Radarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);
    }
  }

  /**
   * Processes one movie Seerr links to a Radarr movie, as the scan would, e.g. after a Radarr
   * event. A movie that no server of its profile type downloads any more, gone or unmonitored
   * without a file, is handled as the scan handles it.
   */
  public async syncMovie(serverId: number, radarrMovieId: number) {
    const settings = getSettings();
    const server = settings.radarr.find((s) => s.id === serverId);
    if (!server?.syncEnabled) return;
    this.enable4kMovie = settings.radarr.some((s) => s.is4k);
    const is4k = this.enable4kMovie && server.is4k;
    const media = await getRepository(Media).findOneBy(
      is4k
        ? {
            mediaType: MediaType.MOVIE,
            serviceId4k: serverId,
            externalServiceId4k: radarrMovieId,
          }
        : {
            mediaType: MediaType.MOVIE,
            serviceId: serverId,
            externalServiceId: radarrMovieId,
          }
    );
    if (!media) return;

    // Whether a server has the movie, unmonitored and without a file
    let abandonedEntry = false;
    try {
      const movie = await radarrApi(server).getMovie({ id: radarrMovieId });
      await this.processRadarrMovie(movie, server);
      if (movie.monitored || movie.hasFile) return;
      abandonedEntry = true;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }

    const others = settings.radarr.filter(
      (s) => s.id !== serverId && (this.enable4kMovie && s.is4k) === is4k
    );
    // As in the orphan cleanup: a server not synced may hold the movie.
    if (others.some((s) => !s.syncEnabled)) return;
    for (const other of others) {
      const movie = await radarrApi(other)
        .getMovieByTmdbId(media.tmdbId)
        .catch((e: Error) => {
          if (e.message === 'Movie not found') return undefined;
          throw e;
        });
      if (!movie?.id) continue;
      await this.processRadarrMovie(movie, other);
      if (movie.monitored || movie.hasFile) return;
      abandonedEntry = true;
    }
    if (abandonedEntry) {
      await this.resolveStatusResets(
        (m, mIs4k) => m.id === media.id && mIs4k === is4k
      );
    } else {
      await this.resetOrphanedMovie(media, is4k);
    }
  }

  private async processRadarrMovie(
    radarrMovie: RadarrMovie,
    server = this.currentServer
  ): Promise<void> {
    const server4k = this.enable4kMovie && server.is4k;
    if (server4k) {
      this.scanned4kTmdbIds.add(radarrMovie.tmdbId);
    } else {
      this.scannedTmdbIds.add(radarrMovie.tmdbId);
    }

    const processing = !radarrMovie.hasFile && radarrMovie.monitored;
    if (processing) {
      if (server4k) {
        this.processing4kTmdbIds.add(radarrMovie.tmdbId);
      } else {
        this.processingTmdbIds.add(radarrMovie.tmdbId);
      }
    }

    try {
      await this.processMovie(radarrMovie.tmdbId, {
        is4k: server4k,
        serviceId: server.id,
        externalServiceId: radarrMovie.id,
        externalServiceSlug: radarrMovie.titleSlug,
        title: radarrMovie.title,
        processing,
        hasFile: radarrMovie.hasFile,
      });
    } catch (e) {
      this.log('Failed to process Radarr media', 'error', {
        errorMessage: e.message,
        title: radarrMovie.title,
      });
    }
  }

  private async existsInAnyServer(
    tmdbId: number,
    is4k: boolean
  ): Promise<boolean> {
    const servers = this.servers.filter(
      (server) =>
        server.syncEnabled && (this.enable4kMovie && server.is4k) === is4k
    );

    for (const server of servers) {
      try {
        const api = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });
        const movies = await api.getLibraryMoviesByTmdbId(tmdbId);

        if (movies.some((movie) => movie.tmdbId === tmdbId)) {
          return true;
        }
      } catch (e) {
        this.log(
          `Could not confirm movie ${tmdbId} against Radarr server ${server.name}. Skipping cleanup for it.`,
          'warn',
          { errorMessage: e.message }
        );
        return true;
      }
    }

    return false;
  }

  /** For a movie no Radarr server of its profile type has. */
  private async resetOrphanedMovie(media: Media, is4k: boolean) {
    const statusKey = is4k ? 'status4k' : 'status';
    if (media[statusKey] !== MediaStatus.PROCESSING) return;
    await this.failUnfulfillableRequests(media, is4k, null);
    media[statusKey] = MediaStatus.UNKNOWN;
    await getRepository(Media).save(media);
    this.log(
      `Movie ${media.tmdbId} not found in any ${is4k ? '4K ' : ''}Radarr server. ${is4k ? '4K status' : 'Status'} reset to UNKNOWN.`,
      'info'
    );
  }

  private async cleanupOrphanedMovies(): Promise<void> {
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      const processingMovies = await mediaRepository.find({
        where: { mediaType: MediaType.MOVIE, status: MediaStatus.PROCESSING },
      });

      for (const media of processingMovies) {
        if (!this.scannedTmdbIds.has(media.tmdbId)) {
          if (await this.existsInAnyServer(media.tmdbId, false)) {
            continue;
          }

          await this.resetOrphanedMovie(media, false);
        }
      }
    } else {
      this.log(
        'Skipping orphaned movie cleanup: no standard Radarr servers were scanned.',
        'info'
      );
    }

    if (this.didScan4k) {
      const processing4kMovies = await mediaRepository.find({
        where: {
          mediaType: MediaType.MOVIE,
          status4k: MediaStatus.PROCESSING,
        },
      });

      for (const media of processing4kMovies) {
        if (!this.scanned4kTmdbIds.has(media.tmdbId)) {
          if (await this.existsInAnyServer(media.tmdbId, true)) {
            continue;
          }

          await this.resetOrphanedMovie(media, true);
        }
      }
    } else if (this.enable4kMovie) {
      this.log(
        'Skipping orphaned 4K movie cleanup: no 4K Radarr servers were scanned.',
        'info'
      );
    }
  }
}

const radarrApi = (server: RadarrSettings) =>
  new RadarrAPI({
    apiKey: server.apiKey,
    url: RadarrAPI.buildUrl(server, '/api/v3'),
  });

export const radarrScanner = new RadarrScanner();
