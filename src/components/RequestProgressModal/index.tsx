import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import Tooltip from '@app/components/Common/Tooltip';
import RequestBlock from '@app/components/RequestBlock';
import ProgressStepper from '@app/components/RequestProgressModal/ProgressStepper';
import useRequestProgress from '@app/hooks/useRequestProgress';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  CheckCircleIcon,
  EllipsisHorizontalCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/solid';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type {
  ProgressDownload,
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

// p90 of a download says nothing before its size is known; the client ETA does
const stepEstimate = (
  step: ProgressStep,
  downloads?: ProgressDownload[]
): number | undefined => {
  const etas = (downloads ?? [])
    .map((d) => d.etaMs)
    .filter((eta): eta is number => eta !== undefined);
  return step.key === 'grabbed' && etas.length > 0
    ? Math.max(...etas)
    : step.p90Ms;
};

const StepIcon = ({ status }: { status: ProgressStep['status'] }) => {
  switch (status) {
    case 'done':
      return <CheckCircleIcon className="h-6 w-6 text-green-500" />;
    case 'failed':
      return <XCircleIcon className="h-6 w-6 text-red-500" />;
    case 'running':
      return (
        <div className="h-6 w-6 [&_svg]:h-6 [&_svg]:w-6">
          <SmallLoadingSpinner />
        </div>
      );
    default:
      return <EllipsisHorizontalCircleIcon className="h-6 w-6 text-gray-600" />;
  }
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
  const { data: request } = useSWR<MediaRequest>(
    show && progress?.requestId ? `/api/v1/request/${progress.requestId}` : null
  );
  const [now, setNow] = useState(Date.now());
  const ticking = show && !!progress?.steps.some((s) => s.status === 'running');

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
      <span className="text-xs text-gray-500">
        {intl.formatMessage(messages.estimate, {
          duration: formatDuration(ms),
        })}
      </span>
    );

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
        onOk={
          progress?.playUrl
            ? () => window.open(progress.playUrl, '_blank', 'noopener')
            : undefined
        }
        okText={intl.formatMessage(messages.watch)}
        okButtonType="success"
      >
        {progress && (
          <ProgressStepper
            steps={progress.steps}
            downloads={progress.downloads}
            label={(key) => intl.formatMessage(messages[key])}
          />
        )}
        <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 gap-y-1">
          {progress?.steps.map((step) => {
            const elapsed = stepElapsed(step, now);
            return (
              <div key={step.key} className="contents">
                <div className="mt-2">
                  <StepIcon status={step.status} />
                </div>
                <span
                  className={`mt-2 ${
                    step.status === 'pending' ? 'text-gray-500' : 'text-white'
                  }`}
                >
                  {intl.formatMessage(messages[step.key])}
                </span>
                <span className="mt-2 text-right text-xs text-gray-200">
                  {elapsed !== undefined && formatDuration(elapsed)}
                </span>
                <span className="mt-2 text-right">
                  {estimate(stepEstimate(step, progress?.downloads))}
                </span>
                {step.detail && (
                  <div className="col-span-3 col-start-2 break-words text-xs text-gray-400">
                    {step.detail}
                  </div>
                )}
                {step.status === 'failed' && step.error && (
                  <div className="col-span-3 col-start-2 text-xs text-red-400">
                    {step.error}
                  </div>
                )}
                {step.key === 'grabbed' &&
                  step.status === 'running' &&
                  progress?.downloads?.map((dl, i) => (
                    <div
                      key={`dl-${i}`}
                      className="col-span-3 col-start-2 text-xs text-gray-400"
                    >
                      <div className="flex justify-between space-x-2">
                        <Tooltip content={dl.title}>
                          <span className="truncate text-gray-300">
                            {dl.title}
                          </span>
                        </Tooltip>
                        {dl.indexer && (
                          <span className="flex-shrink-0">{dl.indexer}</span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center space-x-2">
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
              </div>
            );
          })}
          {totalMs !== undefined && (
            <>
              <div className="col-span-4 mt-3 border-t border-gray-700" />
              <span />
              <span className="mt-2 text-white">
                {intl.formatMessage(messages.total)}
              </span>
              <span className="mt-2 text-right text-xs text-white">
                {formatDuration(totalMs)}
              </span>
              <span className="mt-2 text-right">
                {estimate(progress?.totalP90Ms)}
              </span>
            </>
          )}
        </div>
        {request && (
          <div className="-mx-4 mt-4 border-t border-gray-700">
            <RequestBlock request={request} />
          </div>
        )}
      </Modal>
    </Transition>
  );
};

interface RequestProgressBadgeProps {
  mediaId?: number;
  is4k?: boolean;
  subTitle?: string;
  children: React.ReactNode;
}

// Makes a media status badge open the progress pop-up on click
export const RequestProgressBadge = ({
  mediaId,
  is4k = false,
  subTitle,
  children,
}: RequestProgressBadgeProps) => {
  const [show, setShow] = useState(false);
  const progress = useRequestProgress(show ? mediaId : undefined, is4k);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        className="inline-flex rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 [&_*]:!cursor-pointer"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setShow(true);
        }}
      >
        {children}
      </button>
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
