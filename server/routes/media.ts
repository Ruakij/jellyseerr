import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TautulliAPI from '@server/api/tautulli';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import type {
  MediaResultsResponse,
  MediaWatchDataResponse,
} from '@server/interfaces/api/mediaInterfaces';
import type { RequestProgress } from '@server/interfaces/api/progressInterfaces';
import { Permission } from '@server/lib/permissions';
import { storedRun } from '@server/lib/requestProgress/history';
import {
  searchAccess,
  searchRequest,
  searchableRequest,
} from '@server/lib/requestProgress/search';
import progressTracker, {
  STEP_KEYS,
} from '@server/lib/requestProgress/tracker';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import type { FindOneOptions } from 'typeorm';
import { EntityNotFoundError, In, IsNull, Not } from 'typeorm';

const mediaRoutes = Router();

mediaRoutes.get('/', async (req, res, next) => {
  const mediaRepository = getRepository(Media);

  const pageSize = req.query.take ? Number(req.query.take) : 20;
  const skip = req.query.skip ? Number(req.query.skip) : 0;

  let statusFilter = undefined;

  switch (req.query.filter) {
    case 'available':
      statusFilter = MediaStatus.AVAILABLE;
      break;
    case 'partial':
      statusFilter = MediaStatus.PARTIALLY_AVAILABLE;
      break;
    case 'allavailable':
      statusFilter = In([
        MediaStatus.AVAILABLE,
        MediaStatus.PARTIALLY_AVAILABLE,
      ]);
      break;
    case 'processing':
      statusFilter = MediaStatus.PROCESSING;
      break;
    case 'pending':
      statusFilter = MediaStatus.PENDING;
      break;
  }

  let sortFilter: FindOneOptions<Media>['order'] = {
    id: 'DESC',
  };

  switch (req.query.sort) {
    case 'modified':
      sortFilter = {
        updatedAt: 'DESC',
      };
      break;
    case 'mediaAdded':
      sortFilter = {
        mediaAddedAt: 'DESC',
      };
  }

  let whereClause: FindOneOptions<Media>['where'];
  if (statusFilter || req.query.sort === 'mediaAdded') {
    whereClause = {};
    if (statusFilter) whereClause.status = statusFilter;
    if (req.query.sort === 'mediaAdded')
      whereClause.mediaAddedAt = Not(IsNull());
  }

  try {
    const [media, mediaCount] = await mediaRepository.findAndCount({
      order: sortFilter,
      where: whereClause,
      take: pageSize,
      skip,
    });
    return res.status(200).json({
      pageInfo: {
        pages: Math.ceil(mediaCount / pageSize),
        pageSize,
        results: mediaCount,
        page: Math.ceil(skip / pageSize) + 1,
      },
      results: media,
    } as MediaResultsResponse);
  } catch (e) {
    next({ status: 500, message: e.message });
  }
});

mediaRoutes.post<
  {
    id: string;
    status: 'available' | 'partial' | 'processing' | 'pending' | 'unknown';
  },
  Media
>(
  '/:id/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const mediaRepository = getRepository(Media);
    const seasonRepository = getRepository(Season);

    const media = await mediaRepository.findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    const is4k = String(req.body.is4k) === 'true';

    switch (req.params.status) {
      case 'available':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;

        if (media.mediaType === MediaType.TV) {
          const expectedSeasons = req.body.seasons ?? [];

          for (const expectedSeason of expectedSeasons) {
            let season = media.seasons.find(
              (s) => s.seasonNumber === expectedSeason?.seasonNumber
            );

            if (!season) {
              // Create the season if it doesn't exist
              season = seasonRepository.create({
                seasonNumber: expectedSeason?.seasonNumber,
              });
              media.seasons.push(season);
            }

            season[is4k ? 'status4k' : 'status'] = MediaStatus.AVAILABLE;
          }
        }
        break;
      case 'partial':
        if (media.mediaType === MediaType.MOVIE) {
          return next({
            status: 400,
            message: 'Only series can be set to be partially available',
          });
        }
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PARTIALLY_AVAILABLE;
        break;
      case 'processing':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PROCESSING;
        break;
      case 'pending':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.PENDING;
        break;
      case 'unknown':
        media[is4k ? 'status4k' : 'status'] = MediaStatus.UNKNOWN;
    }

    await mediaRepository.save(media);

    return res.status(200).json(media);
  }
);

mediaRoutes.delete(
  '/:id',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    try {
      const mediaRepository = getRepository(Media);

      const media = await mediaRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      if (media.status === MediaStatus.BLOCKLISTED) {
        media.resetServiceData();
        await mediaRepository.save(media);
      } else {
        await mediaRepository.remove(media);
      }

      return res.status(204).send();
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return res.status(204).send();
      }
      logger.error('Something went wrong deleting media', {
        label: 'Media',
        mediaId: req.params.id,
        message: e.message,
      });
      next({ status: 500, message: 'Failed to delete media' });
    }
  }
);

mediaRoutes.delete(
  '/:id/file',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    try {
      const settings = getSettings();
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOneOrFail({
        where: { id: Number(req.params.id) },
      });

      const is4k = String(req.query.is4k) === 'true';
      const isMovie = media.mediaType === MediaType.MOVIE;

      let serviceSettings;
      if (isMovie) {
        serviceSettings = settings.radarr.find(
          (radarr) => radarr.isDefault && radarr.is4k === is4k
        );
      } else {
        serviceSettings = settings.sonarr.find(
          (sonarr) => sonarr.isDefault && sonarr.is4k === is4k
        );
      }

      const specificServiceId = is4k ? media.serviceId4k : media.serviceId;
      if (
        specificServiceId &&
        specificServiceId >= 0 &&
        serviceSettings?.id !== specificServiceId
      ) {
        if (isMovie) {
          serviceSettings = settings.radarr.find(
            (radarr) => radarr.id === specificServiceId
          );
        } else {
          serviceSettings = settings.sonarr.find(
            (sonarr) => sonarr.id === specificServiceId
          );
        }
      }

      if (!serviceSettings) {
        const arrName = `${is4k ? '4K ' : ''}${isMovie ? 'Radarr' : 'Sonarr'}`;
        logger.info(
          `There is no default ${arrName} server configured. Did you set any of your ${arrName} servers as default?`,
          {
            label: 'Media Request',
            mediaId: media.id,
          }
        );
        return next({
          status: 409,
          message: `No ${arrName} server configured to delete media files`,
        });
      }

      let service;
      if (isMovie) {
        service = new RadarrAPI({
          apiKey: serviceSettings?.apiKey,
          url: RadarrAPI.buildUrl(serviceSettings, '/api/v3'),
        });
      } else {
        service = new SonarrAPI({
          apiKey: serviceSettings?.apiKey,
          url: SonarrAPI.buildUrl(serviceSettings, '/api/v3'),
        });
      }

      if (isMovie) {
        await (service as RadarrAPI).removeMovie(media.tmdbId);
      } else {
        const tmdb = new TheMovieDb();
        const series = await tmdb.getTvShow({ tvId: media.tmdbId });
        const tvdbId = series.external_ids.tvdb_id ?? media.tvdbId;
        if (!tvdbId) {
          throw new Error('TVDB ID not found');
        }
        await (service as SonarrAPI).removeSeries(tvdbId);

        for (const season of media.seasons) {
          season[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
        }
      }

      media[is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      media.resetServiceData(is4k);
      await mediaRepository.save(media);

      return res.status(204).send();
    } catch (e) {
      if (e instanceof EntityNotFoundError) {
        return next({ status: 404, message: 'Media not found' });
      }
      logger.error('Something went wrong deleting media file', {
        label: 'Media',
        mediaId: req.params.id,
        message: e.message,
      });
      next({ status: 500, message: 'Failed to delete media file' });
    }
  }
);

const HEARTBEAT_MS = 25_000;

mediaRoutes.get<{ mediaId: string }>(
  '/:mediaId/progress',
  async (req, res, next) => {
    const mediaId = Number(req.params.mediaId);
    const is4k = req.query.is4k === 'true';
    // A request of a past run; the live run counts only when it covers it.
    const requestId =
      req.query.requestId !== undefined
        ? Number(req.query.requestId)
        : undefined;
    const covers = (progress: RequestProgress) =>
      requestId === undefined ||
      progress.requests.some((r) => r.id === requestId);
    const media = Number.isInteger(mediaId)
      ? await getRepository(Media).findOne({ where: { id: mediaId } })
      : null;
    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    const status = is4k ? media.status4k : media.status;
    const available =
      status === MediaStatus.AVAILABLE ||
      status === MediaStatus.PARTIALLY_AVAILABLE;
    const untracked: RequestProgress = {
      mediaId,
      is4k,
      requests: [],
      steps: STEP_KEYS.map((key) => ({
        key,
        status: key === 'playable' && available ? 'done' : 'pending',
      })),
      estimatePercentile: getSettings().requestProgress.estimatePercentile,
      playUrl: available
        ? is4k
          ? media.mediaUrl4k
          : media.mediaUrl
        : undefined,
    };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops nginx from buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    const request = await searchableRequest(mediaId, is4k).catch(() => null);
    // The timeline goes out only when it changed; clients keep the last one.
    let sentTimeline: string | undefined;
    const send = (progress: RequestProgress) => {
      const timeline = JSON.stringify(progress.timeline ?? []);
      progress = {
        ...progress,
        timeline:
          timeline === sentTimeline ? undefined : (progress.timeline ?? []),
      };
      sentTimeline = timeline;
      const access = searchAccess(req.user, request);
      const entry = progressTracker.entry(mediaId, is4k);
      const lastSearchedAt = entry?.lastSearchedAt;
      const playable =
        progress.steps.find((s) => s.key === 'playable')?.status === 'done';
      progress = {
        ...progress,
        tmdbId: media.tmdbId,
        mediaType: media.mediaType,
        search: {
          allowed: access.allowed && !playable && !progress.finishedAt,
          retryAfter:
            access.retryAfter !== undefined
              ? new Date(access.retryAfter).toISOString()
              : undefined,
          lastSearchedAt:
            lastSearchedAt !== undefined
              ? new Date(lastSearchedAt).toISOString()
              : undefined,
          running: !!entry?.searchCommands.size,
        },
      };
      res.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`);
    };

    const live = progressTracker.get(mediaId, is4k);
    send(
      live && covers(live)
        ? live
        : ((await storedRun(mediaId, is4k, requestId).catch(() => undefined)) ??
            untracked)
    );
    const onChange = (progress: RequestProgress) => {
      if (
        progress.mediaId === mediaId &&
        progress.is4k === is4k &&
        covers(progress)
      ) {
        send(progress);
      }
    };
    // The final state keeps the pop-up showing the run that just ended.
    const onRemoved = (
      removedId: number,
      removed4k: boolean,
      last: RequestProgress
    ) => {
      if (removedId === mediaId && removed4k === is4k && covers(last)) {
        send(last);
      }
    };
    progressTracker.on('change', onChange);
    progressTracker.on('removed', onRemoved);
    const unwatch = progressTracker.watch(mediaId, is4k);
    // Proxies close idle connections; a comment line keeps it busy without an event.
    const heartbeat = setInterval(
      () => res.write(': heartbeat\n\n'),
      HEARTBEAT_MS
    );
    req.on('close', () => {
      clearInterval(heartbeat);
      progressTracker.off('change', onChange);
      progressTracker.off('removed', onRemoved);
      unwatch();
    });
  }
);

mediaRoutes.post<{ mediaId: string }>(
  '/:mediaId/progress/search',
  async (req, res, next) => {
    const mediaId = Number(req.params.mediaId);
    const is4k = req.query.is4k === 'true';
    const request = Number.isInteger(mediaId)
      ? await searchableRequest(mediaId, is4k)
      : null;
    if (!request) {
      return next({ status: 404, message: 'No open request to search for.' });
    }
    const access = searchAccess(req.user, request);
    if (!access.allowed) {
      return next({ status: 403, message: 'Not allowed to search.' });
    }
    if (access.retryAfter !== undefined) {
      res.setHeader(
        'Retry-After',
        Math.ceil((access.retryAfter - Date.now()) / 1000)
      );
      return next({ status: 429, message: 'Searched recently.' });
    }
    try {
      if (!(await searchRequest(request))) {
        return next({
          status: 409,
          message: 'The media is not in Radarr/Sonarr yet.',
        });
      }
      return res.status(204).send();
    } catch (e) {
      logger.error('Triggering a search failed', {
        label: 'Request Progress',
        mediaId,
        message: e.message,
      });
      return next({ status: 500, message: 'Triggering a search failed.' });
    }
  }
);

mediaRoutes.get<{ id: string }, MediaWatchDataResponse>(
  '/:id/watch_data',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    const settings = getSettings().tautulli;

    if (!settings.hostname || !settings.port || !settings.apiKey) {
      return next({
        status: 404,
        message: 'Tautulli API not configured.',
      });
    }

    const media = await getRepository(Media).findOne({
      where: { id: Number(req.params.id) },
    });

    if (!media) {
      return next({ status: 404, message: 'Media does not exist.' });
    }

    try {
      const tautulli = new TautulliAPI(settings);
      const userRepository = getRepository(User);

      const response: MediaWatchDataResponse = {};

      if (media.ratingKey) {
        const watchStats = await tautulli.getMediaWatchStats(media.ratingKey);
        const watchUsers = await tautulli.getMediaWatchUsers(media.ratingKey);
        const plexIds = watchUsers.map((u) => u.user_id);
        if (!plexIds.length) plexIds.push(-1);

        const users = await userRepository
          .createQueryBuilder('user')
          .where('user.plexId IN (:...plexIds)', { plexIds })
          .getMany();

        const playCount =
          watchStats.find((i) => i.query_days == 0)?.total_plays ?? 0;

        const playCount7Days =
          watchStats.find((i) => i.query_days == 7)?.total_plays ?? 0;

        const playCount30Days =
          watchStats.find((i) => i.query_days == 30)?.total_plays ?? 0;

        response.data = {
          users: users,
          playCount,
          playCount7Days,
          playCount30Days,
        };
      }

      if (media.ratingKey4k) {
        const watchStats4k = await tautulli.getMediaWatchStats(
          media.ratingKey4k
        );
        const watchUsers4k = await tautulli.getMediaWatchUsers(
          media.ratingKey4k
        );
        const plexIds4k = watchUsers4k.map((u) => u.user_id);
        if (!plexIds4k.length) plexIds4k.push(-1);

        const users = await userRepository
          .createQueryBuilder('user')
          .where('user.plexId IN (:...plexIds)', { plexIds: plexIds4k })
          .getMany();

        const playCount =
          watchStats4k.find((i) => i.query_days == 0)?.total_plays ?? 0;

        const playCount7Days =
          watchStats4k.find((i) => i.query_days == 7)?.total_plays ?? 0;

        const playCount30Days =
          watchStats4k.find((i) => i.query_days == 30)?.total_plays ?? 0;

        response.data4k = {
          users,
          playCount,
          playCount7Days,
          playCount30Days,
        };
      }

      return res.status(200).json(response);
    } catch (e) {
      logger.error('Something went wrong fetching media watch data', {
        label: 'API',
        errorMessage: e.message,
        mediaId: req.params.id,
      });
      next({ status: 500, message: 'Failed to fetch watch data.' });
    }
  }
);

export default mediaRoutes;
