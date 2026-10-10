import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import Tooltip from '@app/components/Common/Tooltip';
import {
  idle,
  waitingForRelease,
} from '@app/components/RequestProgressModal/ProgressScene';
import ProgressStepper from '@app/components/RequestProgressModal/ProgressStepper';
import useRequestProgress from '@app/hooks/useRequestProgress';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  PlayIcon,
} from '@heroicons/react/24/solid';
import type {
  ProgressSeason,
  ProgressStep,
  ProgressTimelineEntry,
  RequestProgress,
} from '@server/interfaces/api/progressInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestProgressModal', {
  title: 'Request Progress',
  seasons: '{count, plural, one {Season} other {Seasons}} {seasons}',
  requestedBy: 'requested by {users}',
  requestedByAt: '{user} on {date}',
  expected: 'Expected {date} ({relative})',
  requested: 'Requested',
  searching: 'Searching',
  grabbed: 'Downloading',
  importing: 'Importing',
  inJellyfin: 'Adding to Jellyfin',
  playable: 'Ready',
  estimate: '~{duration}',
  estimateRange: '~{duration} ({low}-{high})',
  awaitingApproval: 'Waiting for approval',
  total: 'Total',
  watch: 'Watch',
  watchQueued: 'Opening when ready',
  watchWhenReady: 'Open in Jellyfin as soon as something can be played',
  finished: 'Finished {date}',
  ended: 'Ended {date}',
  failed: 'Something went wrong at this step.',
  loadFailed: 'The progress could not be loaded.',
  searchAgain: 'Search again',
  searchAvailableIn: 'Available again in {duration}',
  searchRunning: 'A search is running',
  lastSearched: 'Last searched {duration} ago',
  searchStarted: 'Search started.',
  searchCooldown: 'Searched too recently, try again later.',
  searchNoRequest: 'There is no open request to search for.',
  searchNotInArr: 'Not in Radarr/Sonarr yet, try again later.',
  searchFailed: 'Something went wrong while starting the search.',
  waitingRelease: 'Waiting for release',
  waitingRss: 'Waiting for a release to show up',
  waitingGrab: 'Waiting for a new grab',
  releaseDated: 'It is downloaded automatically once released.',
  releaseUndated:
    'No release date known yet; it is downloaded automatically once released.',
  notReleased: 'Not released yet',
  unairedSeason: 'Season {season}: {when}',
  unairedEpisodes:
    'Season {season}: {episodes, plural, one {# episode} other {# episodes}}, {when}',
  firstExpected: 'first expected {date}',
  season: 'Season {season}',
  seasonUnaired:
    '{episodes, plural, one {# episode} other {# episodes}}, {when}',
  seasonPartlyUnaired:
    '{episodes, plural, one {# episode} other {# episodes}} not released yet, {when}',
  nextExpected: 'next {date}',
  dateUnknown: 'date unknown',
  releasedNotFound:
    'Released, but no download found yet; it is grabbed automatically once one shows up.',
  waitingFor: 'for {duration}',
  unitCounts: '{done}/{total}',
  unitsFailed: '{failed} failed',
  details: 'Details',
  ago: '{duration} ago',
  timeline_requested: 'Requested',
  timeline_searchStarted: 'Search started',
  timeline_searchFinished: 'Search finished',
  timeline_searchFailed: 'Search failed',
  timeline_grabbed: 'Grabbed',
  timeline_downloaded: 'Downloaded',
  timeline_downloadFailed: 'Download failed',
  timeline_importBlocked: 'Import blocked',
  timeline_imported: 'Imported',
  timeline_fileDeleted: 'File deleted',
  timeline_inJellyfin: 'Added to Jellyfin',
  timeline_leftJellyfin: 'Removed from Jellyfin',
  timeline_jellyfinTimeout: 'Not listed by Jellyfin',
  timeline_playable: 'Ready to play',
  timeline_requestFailed: 'Request failed',
});

// Step errors that are not technical and shown to every user
const PUBLIC_ERRORS = [
  'Request declined',
  'Request failed',
  'Removed from Sonarr',
  'Removed from Radarr',
  'Not monitored in Sonarr',
  'Not monitored in Radarr',
];

// The two largest units from minutes on, a zero second one left out: 45s, 1m 10s, 12m, 13h 5m, 2d 4h
export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  const two = (
    big: number,
    bigUnit: string,
    small: number,
    smallUnit: string
  ) =>
    small > 0 ? `${big}${bigUnit} ${small}${smallUnit}` : `${big}${bigUnit}`;
  if (s < 60) return `${s}s`;
  if (s < 3600) return two(Math.floor(s / 60), 'm', s % 60, 's');
  if (s < 86400) {
    return two(Math.floor(s / 3600), 'h', Math.floor(s / 60) % 60, 'm');
  }
  return two(Math.floor(s / 86400), 'd', Math.floor(s / 3600) % 24, 'h');
};

const seasonLabel = (seasons?: number[]) =>
  seasons?.map((n) => `S${n}`).join(', ');

// The largest unit that keeps a release a few weeks out from reading as days: in 5 weeks, in 3 months
const relativeUnit = (ms: number): [number, Intl.RelativeTimeFormatUnit] => {
  const days = Math.round(ms / 86_400_000);
  if (days < 14) return [days, 'day'];
  if (days < 60) return [Math.round(days / 7), 'week'];
  if (days < 730) return [Math.round(days / 30.44), 'month'];
  return [Math.round(days / 365.25), 'year'];
};

// Time searches ran, without the waiting between them
const searchTime = (step: ProgressStep, now: number): number | undefined =>
  step.searchMs === undefined && !step.searchStartedAt
    ? undefined
    : (step.searchMs ?? 0) +
      (step.searchStartedAt ? now - Date.parse(step.searchStartedAt) : 0);

const stepElapsed = (step: ProgressStep, now: number): number | undefined => {
  if (!step.startedAt) return undefined;
  const start = Date.parse(step.startedAt);
  // An idle step stopped when its last unit left it
  if (step.status === 'running') {
    return (idle(step) ? Date.parse(step.waitingSince as string) : now) - start;
  }
  if (step.finishedAt) return Date.parse(step.finishedAt) - start;
  return undefined;
};

interface Estimate {
  ms: number;
  rangeMs?: [number, number];
}

// The only reads of the estimate fields of the API: a step's, or the total
const estimateOf = (
  progress: RequestProgress,
  step?: ProgressStep
): Estimate | undefined => {
  if (!step) {
    return progress.totalEstimateMs === undefined
      ? undefined
      : {
          ms: progress.totalEstimateMs,
          rangeMs: progress.totalEstimateRangeMs,
        };
  }
  // A download estimate says nothing before its size is known; the client ETA does
  const etas = (progress.downloads ?? [])
    .map((d) => d.etaMs)
    .filter((eta): eta is number => eta !== undefined);
  if (step.key === 'grabbed' && etas.length > 0) {
    return { ms: Math.max(...etas) };
  }
  return step.estimateMs === undefined
    ? undefined
    : { ms: step.estimateMs, rangeMs: step.estimateRangeMs };
};

// The step the detail panel shows: a failure, else what runs, else the latest
const currentStep = (steps: ProgressStep[]): ProgressStep | undefined =>
  steps.find((s) => s.status === 'failed') ??
  steps.find((s) => s.status === 'running') ??
  [...steps].reverse().find((s) => s.status === 'done') ??
  steps[0];

// The step a season row names: the first not done, else Ready
const seasonStep = (steps: ProgressStep[]): ProgressStep =>
  steps.find((s) => s.status !== 'done') ?? steps[steps.length - 1];

// Expanded by default: the first season with aired units still on its way, else the first
const defaultSeason = (seasons: ProgressSeason[]): ProgressSeason =>
  seasons.find((s) => s.steps && seasonStep(s.steps).status !== 'done') ??
  seasons[0];

const NotReleasedTitle = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-400">
    <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" />
    {children}
  </div>
);

const VIOLET =
  'bg-violet-600/80 border-violet-500 hover:bg-violet-600 hover:border-violet-400 focus:border-violet-700 active:bg-violet-600 active:border-violet-700';

const VIOLET_OUTLINE =
  'border-violet-500 text-violet-200 hover:border-violet-400 hover:bg-violet-600/20';

// Opened without a click, a new tab is usually blocked; the page itself goes there then
const openWatch = (url: string) => {
  const tab = window.open(url, '_blank');
  if (tab) tab.opener = null;
  else window.location.assign(url);
};

interface RequestProgressModalProps {
  show: boolean;
  progress?: RequestProgress;
  // the stream failed for good, so no progress is coming
  error?: boolean;
  onClose: () => void;
}

const RequestProgressModal = ({
  show,
  progress,
  error: loadFailed,
  onClose,
}: RequestProgressModalProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const canManage = hasPermission(Permission.MANAGE_REQUESTS);
  const { addToast } = useToasts();
  const [clock, setClock] = useState(Date.now());
  // A run that is over keeps its times as they were when it ended
  const finishedAt = progress?.finishedAt
    ? Date.parse(progress.finishedAt)
    : undefined;
  const now = finishedAt ?? clock;
  const [searching, setSearching] = useState(false);
  const [watchQueued, setWatchQueued] = useState(false);
  useEffect(() => setWatchQueued(false), [show, progress?.mediaId]);
  const [expandedSeason, setExpandedSeason] = useState<number>();
  const seasonSections = progress?.seasons;
  const expanded =
    seasonSections &&
    (seasonSections.find((s) => s.season === expandedSeason) ??
      defaultSeason(seasonSections));
  // From a 429 Retry-After, until the next progress event carries retryAfter
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number>();
  const retryAt = progress?.search?.retryAfter
    ? Date.parse(progress.search.retryAfter)
    : rateLimitedUntil;
  const step = progress && currentStep(progress.steps);
  const running = !!progress?.steps.some((s) => s.status === 'running');
  const lastSearchedAt =
    step?.key === 'searching' ? progress?.search?.lastSearchedAt : undefined;
  // A dormant run waits for a release, possibly for weeks; its times only move with an update
  const dormant = !!progress?.dormant;
  const ticking =
    show &&
    finishedAt === undefined &&
    ((!dormant &&
      (running ||
        !!lastSearchedAt ||
        !!progress?.requests.some((r) => r.waitingSince))) ||
      (retryAt !== undefined && retryAt > now));

  // Capture phase on window runs before React's handlers, so an enclosing
  // slide-over never sees this Escape (React bubbles through portals)
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [show, onClose]);

  useEffect(() => {
    if (show) setClock(Date.now());
  }, [show, progress]);

  useEffect(() => {
    if (!ticking) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // Opened from lists and settings too, so the pop-up names the media itself
  const { data: details } = useSWR<MovieDetails | TvDetails>(
    progress?.tmdbId && progress.mediaType
      ? `/api/v1/${progress.mediaType}/${progress.tmdbId}`
      : null
  );
  const mediaTitle =
    details && ('title' in details ? details.title : details.name);
  const shortDate = (iso: string) =>
    intl.formatDate(iso, {
      day: 'numeric',
      month: 'short',
      year:
        new Date(iso).getFullYear() === new Date(clock).getFullYear()
          ? undefined
          : 'numeric',
    });
  const requests = progress?.requests ?? [];
  const seasons = [...new Set(requests.flatMap((r) => r.seasons ?? []))].sort(
    (a, b) => a - b
  );
  const requesters = requests.flatMap((r) =>
    !r.requestedBy
      ? []
      : r.requestedAt
        ? intl.formatMessage(messages.requestedByAt, {
            user: r.requestedBy,
            date: shortDate(r.requestedAt),
          })
        : r.requestedBy
  );
  const requestLine = [
    seasons.length > 0 &&
      intl.formatMessage(messages.seasons, {
        count: seasons.length,
        seasons: seasons.join(', '),
      }),
    progress?.is4k && '4K',
    requesters.length > 0 &&
      intl.formatMessage(messages.requestedBy, {
        users: intl.formatList(requesters),
      }),
  ]
    .filter(Boolean)
    .join(' · ');

  const searchStep = progress?.steps.find((s) => s.key === 'searching');
  // The date Radarr/Sonarr waits for, else what TMDB announces; a past one says nothing
  const tmdbDate =
    details &&
    ('title' in details
      ? details.releaseDate
      : details.nextEpisodeToAir?.airDate);
  const waitsForRelease =
    searchStep?.status === 'running' && searchStep.waiting === 'release';
  const releaseAt = waitsForRelease
    ? [progress?.releaseDate, tmdbDate]
        .map((d) => (d ? Date.parse(d) : NaN))
        .find((t) => t > clock)
    : undefined;
  const expected =
    releaseAt !== undefined &&
    intl.formatMessage(messages.expected, {
      date: intl.formatDate(releaseAt, { dateStyle: 'medium' }),
      relative: intl.formatRelativeTime(...relativeUnit(releaseAt - clock), {
        numeric: 'auto',
      }),
    });

  // Seasons to air, outside the steps; a lone one without episodes listed, while the whole run
  // waits for it, says no more than the header date
  const unaired = progress?.unaired ?? [];
  const unairedLines =
    waitsForRelease && unaired.length === 1 && !unaired[0].episodes
      ? []
      : unaired.map(({ season, episodes, airsAt }) => {
          const when = airsAt
            ? intl.formatMessage(messages.firstExpected, {
                date: intl.formatDate(airsAt, { dateStyle: 'medium' }),
              })
            : intl.formatMessage(messages.dateUnknown);
          return episodes
            ? intl.formatMessage(messages.unairedEpisodes, {
                season,
                episodes,
                when,
              })
            : intl.formatMessage(messages.unairedSeason, { season, when });
        });

  const firstStart = progress?.steps.find((s) => s.startedAt)?.startedAt;
  const lastEnd = progress?.steps
    .map((s) => s.finishedAt)
    .filter((f): f is string => !!f)
    .pop();
  const waitedMs = searchStep
    ? Math.max(
        0,
        (stepElapsed(searchStep, now) ?? 0) - (searchTime(searchStep, now) ?? 0)
      )
    : 0;
  const totalMs = firstStart
    ? (running || !lastEnd ? now : Date.parse(lastEnd)) -
      Date.parse(firstStart) -
      waitedMs
    : undefined;

  const formatEstimate = (est: Estimate) =>
    est.rangeMs
      ? intl.formatMessage(messages.estimateRange, {
          duration: formatDuration(est.ms),
          low: formatDuration(est.rangeMs[0]),
          high: formatDuration(est.rangeMs[1]),
        })
      : intl.formatMessage(messages.estimate, {
          duration: formatDuration(est.ms),
        });
  const estimate = (est?: Estimate) =>
    est && <span className="text-gray-500">{formatEstimate(est)}</span>;
  const label = (s: ProgressStep) =>
    intl.formatMessage(
      s.status !== 'running'
        ? messages[s.key]
        : s.key === 'requested'
          ? messages.awaitingApproval
          : s.waiting === 'release'
            ? messages.waitingRelease
            : s.waiting === 'rss'
              ? messages.waitingRss
              : s.waiting === 'grab'
                ? messages.waitingGrab
                : messages[s.key]
    );

  const downloads =
    step?.key === 'grabbed' && step.status === 'running'
      ? (progress?.downloads ?? [])
      : [];
  const waitingNote =
    step && waitingForRelease(step)
      ? intl.formatMessage(
          step.waiting === 'rss'
            ? messages.releasedNotFound
            : expected
              ? messages.releaseDated
              : messages.releaseUndated
        )
      : undefined;
  // The note says what the waiting text of the step would
  const detail = canManage && !waitingNote ? step?.detail : undefined;
  const error =
    step?.status === 'failed'
      ? step.error && (canManage || PUBLIC_ERRORS.includes(step.error))
        ? step.error
        : intl.formatMessage(messages.failed)
      : undefined;
  const playableDone = step?.key === 'playable' && step.status === 'done';
  // The shown season once one of its units plays, else the first season that has one
  const ownPlayUrl = seasonSections ? expanded?.playUrl : progress?.playUrl;
  const playUrl = ownPlayUrl ?? progress?.playUrl;
  const ownPlayable = (
    seasonSections ? expanded?.steps : progress?.steps
  )?.find((s) => s.key === 'playable');
  // Ready means Jellyfin has every unit, not only that a link exists
  const watchReady = !!ownPlayUrl && ownPlayable?.status === 'done';
  const watchCounts =
    ownPlayUrl && !watchReady && ownPlayable?.counts?.total
      ? intl.formatMessage(messages.unitCounts, { ...ownPlayable.counts })
      : undefined;
  // Nothing on its way right now, so a queued Watch could fire long after it was meant
  const watchBlocked =
    !progress ||
    finishedAt !== undefined ||
    progress.steps.some(
      (s) =>
        s.status === 'failed' || (s.key === 'requested' && s.status !== 'done')
    ) ||
    (!!searchStep &&
      waitingForRelease(searchStep) &&
      !progress.steps.some(
        (s) =>
          ['grabbed', 'importing', 'inJellyfin'].includes(s.key) &&
          s.status === 'running' &&
          !idle(s)
      ));
  const canSearch =
    finishedAt === undefined &&
    !!progress?.search?.allowed &&
    step?.key === 'searching' &&
    (step.status === 'running' || step.status === 'failed');
  const cooldownMs = retryAt !== undefined ? retryAt - now : 0;
  const searchRunning = !!progress?.search?.running;

  useEffect(() => {
    if (!watchQueued) return;
    if (progress?.playUrl) {
      setWatchQueued(false);
      openWatch(progress.playUrl);
    } else if (watchBlocked) {
      setWatchQueued(false);
    }
  }, [watchQueued, progress?.playUrl, watchBlocked]);

  const searchAgain = async () => {
    if (!progress) return;
    setSearching(true);
    try {
      await axios.post(
        `/api/v1/media/${progress.mediaId}/progress/search?is4k=${progress.is4k}`
      );
      addToast(intl.formatMessage(messages.searchStarted), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch (e) {
      const res = axios.isAxiosError(e) ? e.response : undefined;
      const status = res?.status;
      const retrySecs = Number(res?.headers['retry-after']);
      if (status === 429 && retrySecs > 0) {
        setRateLimitedUntil(Date.now() + retrySecs * 1000);
      }
      addToast(
        intl.formatMessage(
          status === 429
            ? messages.searchCooldown
            : status === 404
              ? messages.searchNoRequest
              : status === 409
                ? messages.searchNotInArr
                : messages.searchFailed
        ),
        { autoDismiss: true, appearance: 'error' }
      );
    } finally {
      setSearching(false);
    }
  };

  // The searching step of a dormant run shows its waiting text only
  const waitingStep = (s: ProgressStep) =>
    dormant && s.key === 'searching' && s.status === 'running';

  const stats = (s: ProgressStep) => {
    // Ready is the end state, reached with the last unit in Jellyfin: no time or count of its own
    if (!progress || s.key === 'playable') return {};
    const elapsed =
      s.key === 'searching' ? searchTime(s, now) : stepElapsed(s, now);
    const est = estimateOf(progress, s);
    // Units downloaded, a running download by its bytes; elapsed time against the estimate repeats
    // the two times shown
    const fraction = s.key === 'grabbed' ? s.progress : undefined;
    const percent =
      s.status !== 'running' || idle(s) || fraction === undefined
        ? undefined
        : Math.round(fraction * 100);
    return {
      percent,
      // a step finished within a second (usually requested) has no time worth showing
      time:
        elapsed === undefined || (s.status === 'done' && elapsed < 1000)
          ? undefined
          : formatDuration(elapsed),
      estimate:
        est === undefined || s.status === 'done' || waitingStep(s)
          ? undefined
          : intl.formatMessage(messages.estimate, {
              duration: formatDuration(est.ms),
            }),
      range:
        est?.rangeMs === undefined || s.status === 'done' || waitingStep(s)
          ? undefined
          : `${formatDuration(est.rangeMs[0])}-${formatDuration(est.rangeMs[1])}`,
      counts:
        s.counts && s.counts.total > 1 && s.status !== 'pending'
          ? intl.formatMessage(messages.unitCounts, { ...s.counts })
          : undefined,
      failed:
        s.counts && s.counts.total > 1 && s.counts.failed > 0
          ? intl.formatMessage(messages.unitsFailed, { ...s.counts })
          : undefined,
      waiting:
        s.status === 'running' && s.waiting && s.waitingSince && !dormant
          ? intl.formatMessage(messages.waitingFor, {
              duration: formatDuration(now - Date.parse(s.waitingSince)),
            })
          : undefined,
    };
  };

  const unairedWhen = (airsAt: string | undefined, first: boolean) =>
    airsAt
      ? intl.formatMessage(
          first ? messages.firstExpected : messages.nextExpected,
          {
            date: intl.formatDate(airsAt, { dateStyle: 'medium' }),
          }
        )
      : intl.formatMessage(messages.dateUnknown);

  // One line per season; the expanded one shows its steps
  const seasonRow = ({ season, steps, unaired: toAir }: ProgressSeason) => {
    const current = steps && seasonStep(steps);
    const isExpanded = season === expanded?.season;
    return (
      <div key={season}>
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left text-sm"
          aria-expanded={isExpanded}
          onClick={() => setExpandedSeason(season)}
        >
          <span className="font-semibold text-gray-200">
            {intl.formatMessage(messages.season, { season })}
          </span>
          {current ? (
            <>
              <span
                className={
                  current.status === 'failed' ? 'text-red-400' : 'text-gray-400'
                }
              >
                {label(current)}
              </span>
              {current.counts && (
                <span className="ml-auto tabular-nums text-gray-500">
                  {intl.formatMessage(messages.unitCounts, {
                    ...current.counts,
                  })}
                </span>
              )}
            </>
          ) : (
            <NotReleasedTitle>
              {intl.formatMessage(messages.notReleased)}
            </NotReleasedTitle>
          )}
        </button>
        {toAir && (
          <div
            className={`mt-1 flex items-center gap-1.5 text-xs ${
              current ? 'text-amber-400' : 'text-gray-400'
            }`}
          >
            {current && (
              <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" />
            )}
            {current
              ? intl.formatMessage(messages.seasonPartlyUnaired, {
                  episodes: toAir.episodes ?? 0,
                  when: unairedWhen(toAir.airsAt, false),
                })
              : toAir.episodes
                ? intl.formatMessage(messages.seasonUnaired, {
                    episodes: toAir.episodes,
                    when: unairedWhen(toAir.airsAt, true),
                  })
                : unairedWhen(toAir.airsAt, true)}
          </div>
        )}
        {isExpanded && steps && (
          <div className="mt-3">
            <ProgressStepper steps={steps} label={label} stats={stats} />
          </div>
        )}
      </div>
    );
  };

  // Absolute time, the date only for another day; the age on hover
  const timelineTime = (e: ProgressTimelineEntry) => {
    const at = new Date(e.at);
    const today = at.toDateString() === new Date(clock).toDateString();
    return (
      <Tooltip
        content={intl.formatMessage(messages.ago, {
          duration: formatDuration(clock - at.getTime()),
        })}
      >
        <time
          dateTime={e.at}
          className="flex-shrink-0 tabular-nums text-gray-500"
        >
          {today
            ? intl.formatTime(at, { timeStyle: 'short' })
            : intl.formatDate(at, { dateStyle: 'short', timeStyle: 'short' })}
        </time>
      </Tooltip>
    );
  };

  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show={show}
    >
      <Modal
        loading={!progress && !loadFailed}
        backgroundClickable
        title={mediaTitle ?? intl.formatMessage(messages.title)}
        subTitle={
          (requestLine || expected) && (
            <>
              {requestLine && (
                <span className="block truncate">{requestLine}</span>
              )}
              {expected && (
                <span className="block truncate text-sm font-normal text-gray-400">
                  {expected}
                </span>
              )}
            </>
          )
        }
        onCancel={onClose}
        cancelText={intl.formatMessage(globalMessages.close)}
        footerStart={
          playUrl ? (
            <Button
              as="a"
              href={playUrl}
              target="_blank"
              rel="noopener noreferrer"
              buttonType="success"
              className={watchReady ? undefined : VIOLET}
            >
              <PlayIcon />
              <span>{intl.formatMessage(messages.watch)}</span>
              {watchCounts && (
                <span className="ml-2 tabular-nums opacity-75">
                  {watchCounts}
                </span>
              )}
            </Button>
          ) : watchQueued ? (
            <Button
              buttonType="ghost"
              className={`${VIOLET_OUTLINE} bg-violet-600/20`}
              onClick={() => setWatchQueued(false)}
            >
              <ArrowPathIcon className="animate-spin" />
              <span>{intl.formatMessage(messages.watchQueued)}</span>
            </Button>
          ) : (
            !!progress?.requests.length && (
              <Tooltip
                content={
                  watchBlocked
                    ? (error ?? (step && label(step)))
                    : intl.formatMessage(messages.watchWhenReady)
                }
              >
                {/* A disabled button gets no hover of its own */}
                <span className="inline-flex">
                  <Button
                    buttonType={watchBlocked ? 'default' : 'ghost'}
                    className={watchBlocked ? undefined : VIOLET_OUTLINE}
                    disabled={watchBlocked}
                    onClick={() => setWatchQueued(true)}
                  >
                    <PlayIcon />
                    <span>{intl.formatMessage(messages.watch)}</span>
                  </Button>
                </span>
              </Tooltip>
            )
          )
        }
      >
        {!progress && loadFailed && (
          <p className="text-sm text-red-400">
            {intl.formatMessage(messages.loadFailed)}
          </p>
        )}
        {/* Sections in one spacing scale, a line between each */}
        <div className="divide-y divide-gray-700 [&>*]:py-4 [&>:first-child]:pt-0 [&>:last-child]:pb-0">
          {progress && (
            <div>
              {seasonSections ? (
                <div className="space-y-2">
                  {seasonSections.map((section) => seasonRow(section))}
                </div>
              ) : (
                <ProgressStepper
                  steps={progress.steps}
                  label={label}
                  stats={stats}
                />
              )}
              {totalMs !== undefined && (
                <div className="mt-3 text-xs tabular-nums text-gray-300">
                  {intl.formatMessage(messages.total)} {formatDuration(totalMs)}{' '}
                  {finishedAt === undefined && estimate(estimateOf(progress))}
                </div>
              )}
              {finishedAt !== undefined && (
                <div className="mt-1 text-xs text-gray-500">
                  {/* Finished only once Ready; a failed or dropped run ended */}
                  {intl.formatMessage(
                    playableDone ? messages.finished : messages.ended,
                    {
                      date: intl.formatDate(finishedAt, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }),
                    }
                  )}
                </div>
              )}
            </div>
          )}
          {!seasonSections && unairedLines.length > 0 && (
            <div>
              <NotReleasedTitle>
                {intl.formatMessage(messages.notReleased)}
              </NotReleasedTitle>
              <ul className="mt-2 space-y-1 text-sm text-gray-300">
                {unairedLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {(waitingNote ||
            detail ||
            error ||
            downloads.length > 0 ||
            canSearch ||
            lastSearchedAt) && (
            <div className="space-y-3">
              {waitingNote && (
                <p className="text-sm text-amber-400">{waitingNote}</p>
              )}
              {detail && (
                <p className="break-words text-sm text-gray-400">{detail}</p>
              )}
              {error && (
                <p className="break-words text-sm text-red-400">{error}</p>
              )}
              {downloads.map((dl, i) => (
                <div key={`dl-${i}`} className="text-xs text-gray-400">
                  {canManage && (
                    <div className="mb-1 flex justify-between gap-2">
                      <Tooltip content={dl.title}>
                        <span className="truncate text-gray-300">
                          {dl.title}
                        </span>
                      </Tooltip>
                      {dl.indexer && (
                        <span className="flex-shrink-0">{dl.indexer}</span>
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-700">
                      <div
                        className="h-full bg-indigo-500 transition-all duration-500"
                        style={{
                          width: `${
                            dl.size > 0
                              ? ((dl.size - dl.sizeLeft) / dl.size) * 100
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                    {/* A single download's ETA is the estimate of the step */}
                    {downloads.length > 1 &&
                      estimate(
                        dl.etaMs === undefined ? undefined : { ms: dl.etaMs }
                      )}
                  </div>
                </div>
              ))}
              {(canSearch || lastSearchedAt) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-gray-400">
                  {canSearch && (
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      disabled={searching || searchRunning || cooldownMs > 0}
                      onClick={searchAgain}
                    >
                      <MagnifyingGlassIcon />
                      <span>{intl.formatMessage(messages.searchAgain)}</span>
                    </Button>
                  )}
                  {canSearch && searchRunning && (
                    <span>{intl.formatMessage(messages.searchRunning)}</span>
                  )}
                  {canSearch && !searchRunning && cooldownMs > 0 && (
                    <span>
                      {intl.formatMessage(messages.searchAvailableIn, {
                        duration: formatDuration(cooldownMs),
                      })}
                    </span>
                  )}
                  {lastSearchedAt && (
                    <span>
                      {intl.formatMessage(messages.lastSearched, {
                        duration: formatDuration(
                          now - Date.parse(lastSearchedAt)
                        ),
                      })}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {(progress?.timeline ?? []).length > 0 && (
            <details className="text-xs text-gray-400">
              <summary className="cursor-pointer select-none font-semibold uppercase tracking-wide text-gray-400">
                {intl.formatMessage(messages.details)}
              </summary>
              <ol className="mt-2 max-h-60 space-y-1 overflow-y-auto">
                {[...(progress?.timeline ?? [])].reverse().map((e, i) => (
                  <li key={`tl-${i}`} className="flex gap-2">
                    {timelineTime(e)}
                    <span className="min-w-0 break-words">
                      <span
                        className={
                          /Failed|Blocked/.test(e.kind) && !e.resolved
                            ? 'text-red-400'
                            : 'text-gray-200'
                        }
                      >
                        {intl.formatMessage(messages[`timeline_${e.kind}`])}
                      </span>
                      {e.units
                        ? ` ${e.units.join(', ')}`
                        : e.seasons && ` ${seasonLabel(e.seasons)}`}
                      {(canManage || e.kind === 'requested') && e.detail && (
                        <span className="text-gray-500"> - {e.detail}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      </Modal>
    </Transition>
  );
};

interface ProgressTarget {
  mediaId: number;
  is4k: boolean;
  // a past run of this request rather than the live run of the media
  requestId?: number;
}

const OpenProgressContext = createContext<(target: ProgressTarget) => void>(
  () => undefined
);

// One pop-up for the whole app: a badge or list row that opened it unmounts
// when the media or request status changes, and the pop-up must outlive it
export const RequestProgressProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [target, setTarget] = useState<ProgressTarget>();
  const [show, setShow] = useState(false);
  const { progress, error } = useRequestProgress(
    show ? target?.mediaId : undefined,
    !!target?.is4k,
    target?.requestId
  );
  const open = useCallback((t: ProgressTarget) => {
    setTarget(t);
    setShow(true);
  }, []);
  const close = useCallback(() => setShow(false), []);

  return (
    <OpenProgressContext.Provider value={open}>
      {children}
      <RequestProgressModal
        show={show}
        progress={progress}
        error={error}
        onClose={close}
      />
    </OpenProgressContext.Provider>
  );
};

interface RequestProgressTriggerProps {
  mediaId?: number;
  is4k?: boolean;
  requestId?: number;
  children: (open: () => void) => React.ReactNode;
}

// Renders a trigger that opens the progress pop-up for one media variant
export const RequestProgressTrigger = ({
  mediaId,
  is4k = false,
  requestId,
  children,
}: RequestProgressTriggerProps) => {
  const open = useContext(OpenProgressContext);
  return <>{children(() => mediaId && open({ mediaId, is4k, requestId }))}</>;
};

export default RequestProgressModal;
