import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import Tooltip from '@app/components/Common/Tooltip';
import {
  downloadFraction,
  idle,
} from '@app/components/RequestProgressModal/ProgressScene';
import ProgressStepper from '@app/components/RequestProgressModal/ProgressStepper';
import useRequestProgress from '@app/hooks/useRequestProgress';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { MagnifyingGlassIcon, PlayIcon } from '@heroicons/react/24/solid';
import type {
  ProgressStep,
  ProgressTimelineEntry,
  RequestProgress,
} from '@server/interfaces/api/progressInterfaces';
import axios from 'axios';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestProgressModal', {
  title: 'Request Progress',
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
  failed: 'Something went wrong at this step.',
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
  waitingRss: 'Waiting for RSS',
  waitingGrab: 'Waiting for a new grab',
  waitingFor: 'for {duration}',
  unitCounts: '{done}/{total}',
  unitEpisodes: '{done}/{total} episodes',
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

// The two largest units, the second only from hours on: 45s, 12m, 13h 5m, 2d 4h
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
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    return two(Math.floor(s / 3600), 'h', Math.floor(s / 60) % 60, 'm');
  }
  return two(Math.floor(s / 86400), 'd', Math.floor(s / 3600) % 24, 'h');
};

const seasonLabel = (seasons?: number[]) =>
  seasons?.map((n) => `S${n}`).join(', ');

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

interface RequestProgressModalProps {
  show: boolean;
  progress?: RequestProgress;
  subTitle?: string;
  onClose: () => void;
}

const RequestProgressModal = ({
  show,
  progress,
  subTitle,
  onClose,
}: RequestProgressModalProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const canManage = hasPermission(Permission.MANAGE_REQUESTS);
  const { addToast } = useToasts();
  const [now, setNow] = useState(Date.now());
  const [searching, setSearching] = useState(false);
  // From a 429 Retry-After, until the next progress event carries retryAfter
  const [rateLimitedUntil, setRateLimitedUntil] = useState<number>();
  const retryAt = progress?.search?.retryAfter
    ? Date.parse(progress.search.retryAfter)
    : rateLimitedUntil;
  const step = progress && currentStep(progress.steps);
  const running = !!progress?.steps.some((s) => s.status === 'running');
  const lastSearchedAt =
    step?.key === 'searching' ? progress?.search?.lastSearchedAt : undefined;
  const ticking =
    show &&
    (running ||
      !!lastSearchedAt ||
      !!progress?.requests.some((r) => r.waitingSince) ||
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
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  const firstStart = progress?.steps.find((s) => s.startedAt)?.startedAt;
  const lastEnd = progress?.steps
    .map((s) => s.finishedAt)
    .filter((f): f is string => !!f)
    .pop();
  const searchStep = progress?.steps.find((s) => s.key === 'searching');
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
  const detail = canManage ? step?.detail : undefined;
  const error =
    step?.status === 'failed'
      ? step.error && (canManage || PUBLIC_ERRORS.includes(step.error))
        ? step.error
        : intl.formatMessage(messages.failed)
      : undefined;
  // Ready means Jellyfin has every unit, not only that a link exists
  const playUrl =
    step?.key === 'playable' && step.status === 'done'
      ? progress?.playUrl
      : undefined;
  const canSearch =
    !!progress?.search?.allowed &&
    step?.key === 'searching' &&
    (step.status === 'running' || step.status === 'failed');
  const cooldownMs = retryAt !== undefined ? retryAt - now : 0;
  const searchRunning = !!progress?.search?.running;

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

  const stats = (s: ProgressStep) => {
    if (!progress) return {};
    const elapsed =
      s.key === 'searching' ? searchTime(s, now) : stepElapsed(s, now);
    const est = estimateOf(progress, s);
    const fraction =
      s.key === 'grabbed' ? downloadFraction(progress.downloads) : undefined;
    // searching has no progress signal, elapsed time against its estimate would fake one
    const percent =
      s.status !== 'running' || s.key === 'searching' || idle(s)
        ? undefined
        : fraction !== undefined
          ? Math.round(fraction * 100)
          : elapsed !== undefined && est?.ms
            ? Math.min(99, Math.round((elapsed / est.ms) * 100))
            : undefined;
    return {
      percent,
      // a step finished within a second (usually requested) has no time worth showing
      time:
        elapsed === undefined || (s.status === 'done' && elapsed < 1000)
          ? undefined
          : formatDuration(elapsed),
      estimate:
        est === undefined || s.status === 'done'
          ? undefined
          : intl.formatMessage(messages.estimate, {
              duration: formatDuration(est.ms),
            }),
      range:
        est?.rangeMs === undefined || s.status === 'done'
          ? undefined
          : `${formatDuration(est.rangeMs[0])}-${formatDuration(est.rangeMs[1])}`,
      counts:
        s.counts && s.counts.total > 1 && s.status !== 'pending'
          ? intl.formatMessage(
              // episodes only come with the importing step of a series
              s.episodes ? messages.unitEpisodes : messages.unitCounts,
              { ...s.counts }
            )
          : undefined,
      failed:
        s.counts && s.counts.total > 1 && s.counts.failed > 0
          ? intl.formatMessage(messages.unitsFailed, { ...s.counts })
          : undefined,
      waiting:
        s.status === 'running' && s.waiting && s.waitingSince
          ? intl.formatMessage(messages.waitingFor, {
              duration: formatDuration(now - Date.parse(s.waitingSince)),
            })
          : undefined,
    };
  };

  // The stepper shows the current step and its time; a line names the request only
  const requestLines = (progress?.requests ?? []).flatMap((r) => {
    const parts = [seasonLabel(r.seasons), r.requestedBy].filter(Boolean);
    return parts.length > 0 ? [<li key={r.id}>{parts.join(' · ')}</li>] : [];
  });

  // Absolute time, the date only for another day; the age on hover
  const timelineTime = (e: ProgressTimelineEntry) => {
    const at = new Date(e.at);
    const today = at.toDateString() === new Date(now).toDateString();
    return (
      <Tooltip
        content={intl.formatMessage(messages.ago, {
          duration: formatDuration(now - at.getTime()),
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
        loading={!progress}
        backgroundClickable
        title={intl.formatMessage(messages.title)}
        subTitle={subTitle}
        onCancel={onClose}
        cancelText={intl.formatMessage(globalMessages.close)}
      >
        {/* Sections in one spacing scale, a line between each */}
        <div className="divide-y divide-gray-700 [&>*]:py-4 [&>:first-child]:pt-0 [&>:last-child]:pb-0">
          {requestLines.length > 0 && (
            <ul className="space-y-1 text-sm text-gray-300">{requestLines}</ul>
          )}
          {progress && (
            <div>
              <ProgressStepper
                steps={progress.steps}
                downloads={progress.downloads}
                label={label}
                stats={stats}
              />
              {totalMs !== undefined && (
                <div className="mt-3 text-xs tabular-nums text-gray-300">
                  {intl.formatMessage(messages.total)} {formatDuration(totalMs)}{' '}
                  {estimate(estimateOf(progress))}
                </div>
              )}
            </div>
          )}
          {(detail ||
            error ||
            downloads.length > 0 ||
            playUrl ||
            canSearch ||
            lastSearchedAt) && (
            <div className="space-y-3">
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
                    {estimate(
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
              {playUrl && (
                <Button
                  as="a"
                  href={playUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  buttonType="success"
                >
                  <PlayIcon />
                  <span>{intl.formatMessage(messages.watch)}</span>
                </Button>
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
                          /Failed|Blocked/.test(e.kind)
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
  subTitle?: string;
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
  const progress = useRequestProgress(
    show ? target?.mediaId : undefined,
    !!target?.is4k
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
        subTitle={target?.subTitle}
        onClose={close}
      />
    </OpenProgressContext.Provider>
  );
};

interface RequestProgressTriggerProps {
  mediaId?: number;
  is4k?: boolean;
  subTitle?: string;
  children: (open: () => void) => React.ReactNode;
}

// Renders a trigger that opens the progress pop-up for one media variant
export const RequestProgressTrigger = ({
  mediaId,
  is4k = false,
  subTitle,
  children,
}: RequestProgressTriggerProps) => {
  const open = useContext(OpenProgressContext);
  return <>{children(() => mediaId && open({ mediaId, is4k, subTitle }))}</>;
};

export default RequestProgressModal;
