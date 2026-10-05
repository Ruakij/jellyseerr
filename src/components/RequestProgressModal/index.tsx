import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import Tooltip from '@app/components/Common/Tooltip';
import RequestBlock from '@app/components/RequestBlock';
import StepGraphic, {
  downloadFraction,
} from '@app/components/RequestProgressModal/ProgressScene';
import ProgressStepper from '@app/components/RequestProgressModal/ProgressStepper';
import useRequestProgress from '@app/hooks/useRequestProgress';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PlayIcon } from '@heroicons/react/24/solid';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type {
  ProgressStep,
  RequestProgress,
} from '@server/interfaces/api/progressInterfaces';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestProgressModal', {
  title: 'Request Progress',
  requested: 'Requested',
  searching: 'Searching',
  grabbed: 'Downloading',
  importing: 'Importing',
  inJellyfin: 'Adding to Jellyfin',
  playable: 'Ready',
  estimate: '~{duration}',
  total: 'Total',
  watch: 'Watch',
  failed: 'Something went wrong at this step.',
});

const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const stepElapsed = (step: ProgressStep, now: number): number | undefined => {
  if (!step.startedAt) return undefined;
  const start = Date.parse(step.startedAt);
  if (step.status === 'running') return now - start;
  if (step.finishedAt) return Date.parse(step.finishedAt) - start;
  return undefined;
};

// The only reads of the estimate fields of the API: a step's, or the total
const estimateMs = (
  progress: RequestProgress,
  step?: ProgressStep
): number | undefined => {
  if (!step) return progress.totalP90Ms;
  // p90 of a download says nothing before its size is known; the client ETA does
  const etas = (progress.downloads ?? [])
    .map((d) => d.etaMs)
    .filter((eta): eta is number => eta !== undefined);
  return step.key === 'grabbed' && etas.length > 0
    ? Math.max(...etas)
    : step.p90Ms;
};

// The step the detail panel shows: a failure, else what runs, else the latest
const currentStep = (steps: ProgressStep[]): ProgressStep | undefined =>
  steps.find((s) => s.status === 'failed') ??
  steps.find((s) => s.status === 'running') ??
  [...steps].reverse().find((s) => s.status === 'done') ??
  steps[0];

const sceneColor: Record<ProgressStep['status'], string> = {
  done: 'text-green-400',
  running: 'text-indigo-300',
  failed: 'text-red-400',
  pending: 'text-gray-600',
};

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
  const { data: request } = useSWR<MediaRequest>(
    show && progress?.requestId ? `/api/v1/request/${progress.requestId}` : null
  );
  const [now, setNow] = useState(Date.now());
  const ticking = show && !!progress?.steps.some((s) => s.status === 'running');

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
  const totalMs = firstStart
    ? (ticking || !lastEnd ? now : Date.parse(lastEnd)) - Date.parse(firstStart)
    : undefined;

  const estimate = (ms?: number) =>
    ms !== undefined && (
      <span className="text-gray-500">
        {intl.formatMessage(messages.estimate, {
          duration: formatDuration(ms),
        })}
      </span>
    );

  const step = progress && currentStep(progress.steps);
  const stepMs = step && stepElapsed(step, now);
  const downloads =
    step?.key === 'grabbed' && step.status === 'running'
      ? (progress?.downloads ?? [])
      : [];

  const stats = (s: ProgressStep) => {
    if (!progress) return {};
    const elapsed = stepElapsed(s, now);
    const est = estimateMs(progress, s);
    const fraction =
      s.key === 'grabbed' ? downloadFraction(progress.downloads) : undefined;
    const percent =
      s.status === 'done'
        ? 100
        : s.status !== 'running'
          ? undefined
          : fraction !== undefined
            ? Math.round(fraction * 100)
            : elapsed !== undefined && est
              ? Math.min(99, Math.round((elapsed / est) * 100))
              : undefined;
    return {
      percent,
      time: elapsed === undefined ? undefined : formatDuration(elapsed),
      estimate:
        est === undefined || s.status === 'done'
          ? undefined
          : intl.formatMessage(messages.estimate, {
              duration: formatDuration(est),
            }),
    };
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
        {request && (
          <div className="-mx-4 mb-4 border-b border-gray-700">
            <RequestBlock request={request} />
          </div>
        )}
        {progress && (
          <>
            <ProgressStepper
              steps={progress.steps}
              downloads={progress.downloads}
              label={(key) => intl.formatMessage(messages[key])}
              stats={stats}
            />
            {totalMs !== undefined && (
              <div className="mt-2 text-center text-xs tabular-nums text-gray-300">
                {intl.formatMessage(messages.total)} {formatDuration(totalMs)}{' '}
                {estimate(estimateMs(progress))}
              </div>
            )}
          </>
        )}
        {step && progress && (
          <div className="mt-4 flex flex-col items-center gap-4 rounded-lg bg-gray-900/40 p-4 sm:flex-row sm:items-start">
            <div
              className={`flex h-24 w-24 flex-shrink-0 items-center justify-center ${
                sceneColor[step.status]
              }`}
            >
              <StepGraphic
                step={step}
                downloads={progress.downloads}
                className={
                  step.status === 'running' || step.key === 'playable'
                    ? 'h-24 w-24'
                    : 'h-14 w-14'
                }
              />
            </div>
            <div className="w-full min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <h3 className="text-lg font-semibold text-white">
                  {intl.formatMessage(messages[step.key])}
                </h3>
                <span className="text-sm tabular-nums text-gray-300">
                  {stepMs !== undefined && formatDuration(stepMs)}{' '}
                  {estimate(estimateMs(progress, step))}
                </span>
              </div>
              {canManage && step.detail && (
                <p className="mt-1 break-words text-sm text-gray-400">
                  {step.detail}
                </p>
              )}
              {step.status === 'failed' && (
                <p className="mt-2 break-words text-sm text-red-400">
                  {canManage && step.error
                    ? step.error
                    : intl.formatMessage(messages.failed)}
                </p>
              )}
              {downloads.map((dl, i) => (
                <div key={`dl-${i}`} className="mt-3 text-xs text-gray-400">
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
                    {estimate(dl.etaMs)}
                  </div>
                </div>
              ))}
              {step.key === 'playable' && progress.playUrl && (
                <Button
                  as="a"
                  href={progress.playUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  buttonType="success"
                  className="mt-3"
                >
                  <PlayIcon />
                  <span>{intl.formatMessage(messages.watch)}</span>
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </Transition>
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
  const [show, setShow] = useState(false);
  const progress = useRequestProgress(show ? mediaId : undefined, is4k);

  return (
    <>
      {children(() => setShow(true))}
      <RequestProgressModal
        show={show}
        progress={progress}
        subTitle={subTitle}
        onClose={() => setShow(false)}
      />
    </>
  );
};

export default RequestProgressModal;
