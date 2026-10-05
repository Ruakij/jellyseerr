import {
  ArrowDownIcon,
  CheckIcon,
  FolderArrowDownIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  RectangleStackIcon,
} from '@heroicons/react/24/solid';
import type {
  ProgressDownload,
  ProgressStep,
  ProgressStepKey,
} from '@server/interfaces/api/progressInterfaces';
import { Fragment } from 'react';

// Keyframes live in globals.css; each animation mimics what the step does
const stepVisuals: Record<
  ProgressStepKey,
  { Icon: typeof CheckIcon; running?: string; done?: string }
> = {
  requested: { Icon: CheckIcon },
  searching: {
    Icon: MagnifyingGlassIcon,
    running: 'motion-safe:animate-[progress-scan_1.6s_ease-in-out_infinite]',
  },
  grabbed: {
    Icon: ArrowDownIcon,
    running: 'motion-safe:animate-[progress-drop_1.4s_ease-in-out_infinite]',
  },
  importing: {
    Icon: FolderArrowDownIcon,
    running: 'motion-safe:animate-[progress-slide-in_1.6s_ease-out_infinite]',
  },
  inJellyfin: {
    Icon: RectangleStackIcon,
    running: 'motion-safe:animate-[progress-throb_1.4s_ease-in-out_infinite]',
  },
  playable: {
    Icon: PlayIcon,
    done: 'motion-safe:animate-[progress-pop_0.5s_ease-out]',
  },
};

const circleClass: Record<ProgressStep['status'], string> = {
  done: 'bg-green-600 text-white',
  running: 'border-2 border-indigo-500 bg-indigo-500/20 text-indigo-200',
  failed: 'bg-red-600 text-white',
  pending: 'border border-gray-600 text-gray-600',
};

const downloadFraction = (downloads?: ProgressDownload[]) => {
  const size = (downloads ?? []).reduce((sum, d) => sum + d.size, 0);
  const left = (downloads ?? []).reduce((sum, d) => sum + d.sizeLeft, 0);
  return size > 0 ? (size - left) / size : undefined;
};

const Connector = ({
  step,
  downloads,
}: {
  step: ProgressStep;
  downloads?: ProgressDownload[];
}) => {
  const fraction =
    step.status === 'done'
      ? 1
      : step.status === 'running' && step.key === 'grabbed'
        ? downloadFraction(downloads)
        : 0;
  const shimmer = step.status === 'running' && fraction === undefined;

  return (
    <div className="relative mx-1 mt-[18px] h-1 flex-1 overflow-hidden rounded-full bg-gray-700">
      <div
        className="h-full bg-green-600 transition-[width] duration-700 ease-out"
        style={{ width: `${(fraction ?? 0) * 100}%` }}
      />
      {shimmer && (
        <div className="absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-indigo-500 to-transparent motion-safe:animate-[progress-shimmer_1.5s_linear_infinite] motion-reduce:w-full motion-reduce:via-indigo-500/40" />
      )}
    </div>
  );
};

interface ProgressStepperProps {
  steps: ProgressStep[];
  downloads?: ProgressDownload[];
  label: (key: ProgressStepKey) => string;
}

const ProgressStepper = ({ steps, downloads, label }: ProgressStepperProps) => (
  <ol className="mb-6 flex items-start">
    {steps.map((step, i) => {
      const { Icon, running, done } = stepVisuals[step.key];
      const animation =
        step.status === 'running'
          ? running
          : step.status === 'done'
            ? done
            : undefined;
      return (
        <Fragment key={step.key}>
          <li
            className="flex w-10 flex-shrink-0 flex-col items-center sm:w-16"
            title={label(step.key)}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-full transition-colors duration-500 ${
                circleClass[step.status]
              }`}
            >
              <Icon className={`h-5 w-5 ${animation ?? ''}`} />
            </div>
            <span
              className={`sr-only mt-1 text-center text-xs leading-tight sm:not-sr-only ${
                step.status === 'pending'
                  ? 'text-gray-500'
                  : step.status === 'failed'
                    ? 'text-red-400'
                    : 'text-gray-200'
              }`}
            >
              {label(step.key)}
            </span>
          </li>
          {i < steps.length - 1 && (
            <Connector step={step} downloads={downloads} />
          )}
        </Fragment>
      );
    })}
  </ol>
);

export default ProgressStepper;
