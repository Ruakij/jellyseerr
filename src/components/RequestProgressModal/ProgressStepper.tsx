import StepGraphic, {
  downloadFraction,
} from '@app/components/RequestProgressModal/ProgressScene';
import type {
  ProgressDownload,
  ProgressStep,
} from '@server/interfaces/api/progressInterfaces';
import { Fragment } from 'react';

const circleClass: Record<ProgressStep['status'], string> = {
  done: 'bg-green-600 text-white',
  running: 'border-2 border-indigo-500 bg-indigo-500/20 text-indigo-200',
  failed: 'bg-red-600 text-white',
  pending: 'border border-gray-600 text-gray-600',
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
    <div className="relative mx-1 mt-[26px] h-1 flex-1 overflow-hidden rounded-full bg-gray-700">
      <div
        className="h-full bg-green-600 transition-[width] duration-700 ease-out"
        style={{ width: `${(fraction ?? 0) * 100}%` }}
      />
      {shimmer && (
        <div className="ps-shimmer absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-indigo-500 to-transparent motion-reduce:w-full motion-reduce:via-indigo-500/40" />
      )}
    </div>
  );
};

interface ProgressStepperProps {
  steps: ProgressStep[];
  downloads?: ProgressDownload[];
  label: (step: ProgressStep) => string;
  stats: (step: ProgressStep) => {
    percent?: number;
    time?: string;
    estimate?: string;
    range?: string;
    episodes?: string;
  };
}

const ProgressStepper = ({
  steps,
  downloads,
  label,
  stats,
}: ProgressStepperProps) => (
  <ol className="flex items-start">
    {steps.map((step, i) => {
      const { percent, time, estimate, range, episodes } = stats(step);
      const running = step.status === 'running';
      return (
        <Fragment key={step.key}>
          <li
            className={`flex flex-shrink-0 flex-col items-center ${
              running ? 'w-14 sm:w-20' : 'w-12 sm:w-16'
            }`}
            title={label(step)}
          >
            <div className="flex h-14 items-center">
              <div
                className={`flex items-center justify-center overflow-hidden rounded-full transition-all duration-500 ${
                  running ? 'h-14 w-14' : 'h-10 w-10'
                } ${circleClass[step.status]}`}
              >
                <StepGraphic
                  step={step}
                  downloads={downloads}
                  className={running ? 'h-12 w-12' : 'h-5 w-5'}
                />
              </div>
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
              {label(step)}
            </span>
            <span className="mt-0.5 flex flex-col items-center whitespace-nowrap text-[10px] tabular-nums leading-tight">
              {percent !== undefined && (
                <span className="font-semibold text-gray-200">{percent}%</span>
              )}
              {time && <span className="text-gray-400">{time}</span>}
              {estimate && <span className="text-gray-500">{estimate}</span>}
              {range && (
                <span className="hidden text-gray-600 sm:inline">{range}</span>
              )}
            </span>
            {episodes && (
              <span className="mt-0.5 text-center text-[10px] leading-tight text-gray-300">
                {episodes}
              </span>
            )}
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
