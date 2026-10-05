import RadarrAPI from '@server/api/servarr/radarr';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import {
  externalId,
  requestServer,
  servarrApi,
} from '@server/lib/requestProgress/events';

export const SEARCH_COOLDOWN_MS = 15 * 60 * 1000;

// In memory: a restart lifts the cooldowns, which costs at most one extra search per media.
const manualSearches = new Map<string, number>();
const variant = (request: MediaRequest) =>
  `${request.media.id}:${request.is4k}`;

/** The newest request of a media variant, if Radarr/Sonarr could still search for it. */
export async function searchableRequest(
  mediaId: number,
  is4k: boolean
): Promise<MediaRequest | null> {
  const request = await getRepository(MediaRequest).findOne({
    where: { media: { id: mediaId }, is4k },
    order: { id: 'DESC' },
  });
  if (
    !request ||
    (request.status !== MediaRequestStatus.APPROVED &&
      request.status !== MediaRequestStatus.COMPLETED)
  ) {
    return null;
  }
  const status = is4k ? request.media.status4k : request.media.status;
  return status === MediaStatus.AVAILABLE ? null : request;
}

/**
 * Request managers may search any time, holders of REQUEST_SEARCH once per cooldown. `retryAfter`
 * is set while the cooldown holds for this user.
 */
export function searchAccess(
  user: User | undefined,
  request: MediaRequest | null,
  now = Date.now()
): { allowed: boolean; retryAfter?: number } {
  if (!user || !request) return { allowed: false };
  const manager = user.hasPermission(Permission.MANAGE_REQUESTS);
  if (!manager && !user.hasPermission(Permission.REQUEST_SEARCH)) {
    return { allowed: false };
  }
  const until =
    (manualSearches.get(variant(request)) ?? -Infinity) + SEARCH_COOLDOWN_MS;
  return {
    allowed: true,
    retryAfter: !manager && until > now ? until : undefined,
  };
}

/**
 * Sets what was requested to monitored, as an approved open request wants it, then searches for
 * exactly that: the movie, whole seasons without any file, and the
 * missing aired episodes of the other requested seasons. False when the request has no
 * Radarr/Sonarr item yet.
 */
export async function searchRequest(
  request: MediaRequest,
  now = Date.now()
): Promise<boolean> {
  const server = requestServer(request);
  const arrId = externalId(request.media, request.is4k);
  const api = server && servarrApi(server.type, server.serverId);
  if (!api || !arrId) return false;

  if (api instanceof RadarrAPI) {
    await api.monitorMovie(arrId);
    await api.runCommand('MoviesSearch', { movieIds: [arrId] });
  } else {
    const episodes = await api.getEpisodes(arrId);
    await api.monitorSeasons(
      arrId,
      request.seasons.map((s) => s.seasonNumber),
      episodes
    );
    const missing: number[] = [];
    for (const { seasonNumber } of request.seasons) {
      const aired = episodes.filter(
        (e) =>
          e.seasonNumber === seasonNumber &&
          !!e.airDateUtc &&
          Date.parse(e.airDateUtc) <= now
      );
      if (aired.some((e) => e.hasFile)) {
        missing.push(...aired.filter((e) => !e.hasFile).map((e) => e.id));
      } else {
        await api.runCommand('SeasonSearch', { seriesId: arrId, seasonNumber });
      }
    }
    if (missing.length > 0) {
      await api.runCommand('EpisodeSearch', { episodeIds: missing });
    }
  }
  manualSearches.set(variant(request), now);
  return true;
}
