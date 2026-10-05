import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  CheckCircleIcon,
  EllipsisHorizontalCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/solid';
import type {
  ProgressStep,
  RequestProgress,
} from '@server/interfaces/api/progressInterfaces';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestProgressModal', {
  title: 'Request Progress',
  requested: 'Requested',
  searching: 'Searching',
  grabbed: 'Downloading',
  importing: 'Importing',
  inJellyfin: 'Added to Jellyfin',
  playable: 'Ready',
  usually: 'usually <= {duration}',
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

export const isProgressActive = (progress?: RequestProgress): boolean =>
  !!progress &&
  progress.steps.some((s) => s.status !== 'pending') &&
  !progress.steps.some((s) => s.key === 'playable' && s.status === 'done');

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
        <ul className="space-y-3">
          {progress?.steps.map((step) => {
            const elapsed = stepElapsed(step, now);
            return (
              <li key={step.key} className="flex items-start space-x-3">
                <StepIcon status={step.status} />
                <div className="flex-1">
                  <div className="flex items-baseline justify-between">
                    <span
                      className={
                        step.status === 'pending'
                          ? 'text-gray-500'
                          : 'text-white'
                      }
                    >
                      {intl.formatMessage(messages[step.key])}
                    </span>
                    <span className="space-x-2 text-xs">
                      {elapsed !== undefined && (
                        <span className="text-gray-200">
                          {formatDuration(elapsed)}
                        </span>
                      )}
                      {step.p90Ms !== undefined && (
                        <span className="text-gray-500">
                          {intl.formatMessage(messages.usually, {
                            duration: formatDuration(step.p90Ms),
                          })}
                        </span>
                      )}
                    </span>
                  </div>
                  {step.status === 'failed' && step.error && (
                    <div className="text-xs text-red-400">{step.error}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {totalMs !== undefined && (
          <div className="mt-4 flex justify-between border-t border-gray-700 pt-3 text-white">
            <span>{intl.formatMessage(messages.total)}</span>
            <span className="space-x-2 text-xs">
              <span>{formatDuration(totalMs)}</span>
              {progress?.totalP90Ms !== undefined && (
                <span className="text-gray-500">
                  {intl.formatMessage(messages.usually, {
                    duration: formatDuration(progress.totalP90Ms),
                  })}
                </span>
              )}
            </span>
          </div>
        )}
      </Modal>
    </Transition>
  );
};

export default RequestProgressModal;
