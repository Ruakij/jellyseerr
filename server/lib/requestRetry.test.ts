import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import TheMovieDb from '@server/api/themoviedb';
import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import {
  applyRequestFailure,
  classifyRequestError,
  retryDelayMs,
  retryFailedRequests,
} from '@server/lib/requestRetry';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

let addMovieImpl: () => Promise<RadarrMovie> = async () => {
  throw new Error('not configured');
};
Object.defineProperty(RadarrAPI.prototype, 'addMovie', {
  set() {},
  get() {
    return async () => addMovieImpl();
  },
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  set() {},
  get() {
    return async ({ movieId }: { movieId: number }) =>
      ({
        id: movieId,
        title: 'Test Movie',
        release_date: '2024-01-01',
      }) as unknown as TmdbMovieDetails;
  },
  configurable: true,
});

setupTestDb();

const MINUTE = 60 * 1000;

const connRefused = () =>
  new Error('Failed to add movie to Radarr', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7878'), {
      code: 'ECONNREFUSED',
    }),
  });

const httpError = (status: number, data?: unknown) =>
  new Error('Failed to add movie to Radarr', {
    cause: Object.assign(
      new Error(`Request failed with status code ${status}`),
      { response: { status, data } }
    ),
  });

function configureRadarr(): void {
  const settings = getSettings();
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr',
      hostname: 'localhost',
      port: 7878,
      apiKey: 'test-key',
      baseUrl: '',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/movies',
      is4k: false,
      minimumAvailability: 'released',
      tags: [],
      isDefault: true,
      syncEnabled: false,
      preventSearch: true,
      externalUrl: '',
    } as unknown as RadarrSettings,
  ];
  settings.sonarr = [];
}

async function seedRequest(
  init: Partial<MediaRequest> = {}
): Promise<MediaRequest> {
  const requestedBy = await getRepository(User).findOneOrFail({
    where: { id: 1 },
  });
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: Math.floor(Math.random() * 1e6),
      mediaType: MediaType.MOVIE,
      status: MediaStatus.PROCESSING,
    })
  );
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.FAILED,
      media,
      requestedBy,
      is4k: false,
      ...init,
    })
  );
}

const reload = (id: number) =>
  getRepository(MediaRequest).findOneOrFail({ where: { id } });

// the subscriber notifies after saving the FAILED status
const settle = () => new Promise((r) => setTimeout(r, 50));

async function waitFor(
  id: number,
  done: (r: MediaRequest) => boolean
): Promise<MediaRequest> {
  for (let i = 0; i < 200; i++) {
    const request = await reload(id);
    if (done(request)) return request;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`request ${id} never reached the expected state`);
}

const failedNotifications = () =>
  sendNotificationMock.calls.filter(
    (c) => c.arguments[2] === Notification.MEDIA_FAILED
  ).length;

beforeEach(() => {
  const settings = getSettings();
  settings.main.autoRetryFailedRequests = true;
  settings.main.autoRetryMaxAttempts = 4;
  settings.radarr = [];
  settings.sonarr = [];
  sendNotificationMock.resetCalls();
});

describe('classifyRequestError', () => {
  it('treats network errors in the cause chain as transient', () => {
    const failure = classifyRequestError(connRefused());
    assert.strictEqual(failure.kind, 'transient');
    assert.match(failure.reason, /ECONNREFUSED/);
  });

  it('treats axios timeouts and socket hang ups as transient', () => {
    assert.strictEqual(
      classifyRequestError(new Error('timeout of 10000ms exceeded')).kind,
      'transient'
    );
    assert.strictEqual(
      classifyRequestError(new Error('socket hang up')).kind,
      'transient'
    );
  });

  it('treats HTTP 5xx and 429 as transient', () => {
    assert.strictEqual(classifyRequestError(httpError(503)).kind, 'transient');
    assert.strictEqual(classifyRequestError(httpError(429)).kind, 'transient');
  });

  it('treats other 4xx as permanent and keeps the arr message', () => {
    const failure = classifyRequestError(
      httpError(400, [{ errorMessage: 'This movie has already been added' }])
    );
    assert.strictEqual(failure.kind, 'permanent');
    assert.strictEqual(
      failure.reason,
      'Failed to add movie to Radarr: HTTP 400 - This movie has already been added'
    );
  });

  it('treats plain errors as permanent', () => {
    const failure = classifyRequestError(new Error('Invalid root folder'));
    assert.deepStrictEqual(failure, {
      kind: 'permanent',
      reason: 'Invalid root folder',
    });
  });
});

describe('retry backoff', () => {
  it('waits 5 min, 15 min, 1 h, then 6 h', () => {
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4, 9].map((n) => retryDelayMs(n) / MINUTE),
      [5, 15, 60, 360, 360, 360]
    );
  });

  it('schedules transient failures until the attempts run out', () => {
    const request = new MediaRequest({ retryCount: 2 });
    const before = Date.now();
    const notify = applyRequestFailure(request, {
      kind: 'transient',
      reason: 'down',
    });
    assert.strictEqual(request.status, MediaRequestStatus.FAILED);
    assert.strictEqual(notify, false);
    assert.ok(request.nextRetryAt);
    assert.ok(request.nextRetryAt.getTime() >= before + 60 * MINUTE);

    request.retryCount = 4;
    assert.strictEqual(
      applyRequestFailure(request, { kind: 'transient', reason: 'down' }),
      true
    );
    assert.strictEqual(request.nextRetryAt, null);
  });

  it('never schedules permanent failures or when disabled', () => {
    const request = new MediaRequest({ retryCount: 0 });
    applyRequestFailure(request, { kind: 'permanent', reason: 'bad' });
    assert.strictEqual(request.nextRetryAt, null);

    getSettings().main.autoRetryFailedRequests = false;
    applyRequestFailure(request, { kind: 'transient', reason: 'down' });
    assert.strictEqual(request.nextRetryAt, null);
  });
});

describe('retryFailedRequests', () => {
  it('retries only transient failures that are due', async () => {
    const past = new Date(Date.now() - MINUTE);
    const due = await seedRequest({
      failureKind: 'transient',
      failureReason: 'down',
      nextRetryAt: past,
      retryCount: 1,
    });
    const notDue = await seedRequest({
      failureKind: 'transient',
      failureReason: 'down',
      nextRetryAt: new Date(Date.now() + 10 * MINUTE),
    });
    const permanent = await seedRequest({
      failureKind: 'permanent',
      failureReason: 'bad',
      nextRetryAt: past,
    });

    assert.strictEqual(await retryFailedRequests(), 1);

    const retried = await reload(due.id);
    assert.strictEqual(retried.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(retried.retryCount, 2);
    assert.strictEqual(retried.failureReason, null);
    assert.strictEqual(retried.failureKind, null);
    assert.strictEqual(retried.nextRetryAt, null);
    assert.strictEqual(
      (await reload(notDue.id)).status,
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(
      (await reload(permanent.id)).status,
      MediaRequestStatus.FAILED
    );
  });

  it('does nothing when automatic retries are disabled', async () => {
    getSettings().main.autoRetryFailedRequests = false;
    const due = await seedRequest({
      failureKind: 'transient',
      nextRetryAt: new Date(Date.now() - MINUTE),
    });

    assert.strictEqual(await retryFailedRequests(), 0);
    assert.strictEqual(
      (await reload(due.id)).status,
      MediaRequestStatus.FAILED
    );
  });

  it('stops after the max attempts and notifies once more', async () => {
    configureRadarr();
    addMovieImpl = async () => {
      throw connRefused();
    };

    const request = await seedRequest({ status: MediaRequestStatus.APPROVED });
    let current = await waitFor(
      request.id,
      (r) => r.status === MediaRequestStatus.FAILED
    );
    await settle();
    assert.strictEqual(current.failureKind, 'transient');
    assert.match(current.failureReason ?? '', /ECONNREFUSED/);
    assert.ok(current.nextRetryAt);
    assert.strictEqual(failedNotifications(), 1);

    for (let attempt = 1; attempt <= 4; attempt++) {
      await getRepository(MediaRequest).update(request.id, {
        nextRetryAt: new Date(Date.now() - MINUTE),
      });
      assert.strictEqual(await retryFailedRequests(), 1);
      current = await waitFor(
        request.id,
        (r) => r.status === MediaRequestStatus.FAILED
      );
      await settle();
      assert.strictEqual(current.retryCount, attempt);
      assert.strictEqual(failedNotifications(), attempt < 4 ? 1 : 2);
    }

    assert.strictEqual(current.nextRetryAt, null);
    assert.strictEqual(current.failureKind, 'transient');
    assert.strictEqual(await retryFailedRequests(), 0);
  });

  it('clears the failure once a retry reaches Radarr', async () => {
    configureRadarr();
    addMovieImpl = async () => {
      throw httpError(503);
    };

    const request = await seedRequest({ status: MediaRequestStatus.APPROVED });
    await waitFor(request.id, (r) => r.status === MediaRequestStatus.FAILED);
    await settle();

    addMovieImpl = async () =>
      ({ id: 42, titleSlug: 'test-movie' }) as RadarrMovie;
    await getRepository(MediaRequest).update(request.id, {
      nextRetryAt: new Date(Date.now() - MINUTE),
    });
    await retryFailedRequests();

    const done = await waitFor(
      request.id,
      (r) => r.status === MediaRequestStatus.APPROVED && r.retryCount === 0
    );
    assert.strictEqual(done.failureReason, null);
    assert.strictEqual(done.failureKind, null);
    assert.strictEqual(done.nextRetryAt, null);
    assert.strictEqual(failedNotifications(), 1);
  });
});
