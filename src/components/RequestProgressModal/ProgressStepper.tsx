import StepGraphic, {
  downloadFraction,
  idle,
} from '@app/components/RequestProgressModal/ProgressScene';
import type {
  ProgressDownload,
  ProgressStep,
} from '@server/interfaces/api/progressInterfaces';

const circleClass: Record<ProgressStep['status'], string> = {
  done: 'bg-green-600 text-white',
  running: 'border-2 border-indigo-500 bg-indigo-500/20 text-indigo-200',
  failed: 'bg-red-600 text-white',
  pending: 'border border-gray-600 text-gray-600',
};

const labelClass: Record<ProgressStep['status'], string> = {
  done: 'text-gray-200',
  running: 'text-white',
  failed: 'text-red-400',
  pending: 'text-gray-500',
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
  const shimmer =
    step.status === 'running' && !idle(step) && fraction === undefined;

  return (
    <div className="relative my-1 min-h-3 w-1 flex-1 overflow-hidden rounded-full bg-gray-700">
      <div
        className="w-full bg-green-600 transition-[height] duration-700 ease-out"
        style={{ height: `${(fraction ?? 0) * 100}%` }}
      />
      {shimmer && (
        <div className="ps-shimmer absolute inset-x-0 top-0 h-2/5 bg-gradient-to-b from-transparent via-indigo-500 to-transparent motion-reduce:h-full motion-reduce:via-indigo-500/40" />
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
    counts?: string;
    failed?: string;
    waiting?: string;
  };
}

// One row per step: the icon on a vertical line, the label with its percent, and
// counts, failures, time and estimate on the line under it
const ProgressStepper = ({
  steps,
  downloads,
  label,
  stats,
}: ProgressStepperProps) => (
  <ol>
    {steps.map((step, i) => {
      const { percent, time, estimate, range, counts, failed, waiting } =
        stats(step);
      const running = step.status === 'running';
      const last = i === steps.length - 1;
      return (
        <li key={step.key} className="flex gap-3">
          <div className="flex w-14 flex-shrink-0 flex-col items-center">
            <div
              className={`relative flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full transition-all duration-500 ${
                running ? 'h-14 w-14' : 'h-10 w-10'
              } ${circleClass[step.status]}`}
            >
              {running && (
                <div
                  className="absolute inset-x-0 bottom-0 bg-indigo-500/60 transition-[height] duration-700 ease-out"
                  style={{ height: `${(step.progress ?? 0) * 100}%` }}
                />
              )}
              <StepGraphic
                step={step}
                downloads={downloads}
                className={`relative ${running ? 'h-12 w-12' : 'h-5 w-5'}`}
              />
            </div>
            {!last && <Connector step={step} downloads={downloads} />}
          </div>
          <div
            className={`flex min-w-0 flex-1 flex-col justify-center ${
              running ? 'min-h-14' : 'min-h-10'
            } ${last ? '' : 'pb-3'}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={`truncate text-sm font-medium ${labelClass[step.status]}`}
              >
                {label(step)}
              </span>
              {percent !== undefined && (
                <span className="flex-shrink-0 text-sm font-semibold tabular-nums text-gray-200">
                  {percent}%
                </span>
              )}
            </div>
            {(counts || failed || time || waiting || estimate) && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums leading-tight text-gray-400">
                {counts && (
                  <span className="font-semibold text-gray-200">{counts}</span>
                )}
                {failed && (
                  <span className="rounded-full bg-red-600/20 px-1.5 text-[10px] font-semibold leading-4 text-red-300">
                    {failed}
                  </span>
                )}
                {time && <span>{time}</span>}
                {waiting && <span className="text-yellow-500">{waiting}</span>}
                {estimate && <span className="text-gray-500">{estimate}</span>}
                {range && (
                  <span className="hidden text-gray-600 sm:inline">
                    {range}
                  </span>
                )}
              </div>
            )}
          </div>
        </li>
      );
    })}
  </ol>
);

export default ProgressStepper;
