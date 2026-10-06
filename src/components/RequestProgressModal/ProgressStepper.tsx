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
  running: 'border-2 border-indigo-500 bg-indigo-500/10 text-indigo-200',
  failed: 'bg-red-600 text-white',
  pending: 'border border-gray-600 text-gray-600',
};

const labelClass: Record<ProgressStep['status'], string> = {
  done: 'text-gray-200',
  running: 'text-white',
  failed: 'text-red-400',
  pending: 'text-gray-500',
};

// Share of a running step done; searching has no progress signal
const stepFraction = (
  step: ProgressStep,
  downloads?: ProgressDownload[]
): number | undefined => {
  if (step.status === 'done') return 1;
  if (step.status !== 'running' || step.key === 'searching') return undefined;
  return (
    (step.key === 'grabbed' ? downloadFraction(downloads) : undefined) ??
    step.progress
  );
};

// The line from the center of a step to the center of the next one, under both icons
const Connector = ({
  step,
  downloads,
}: {
  step: ProgressStep;
  downloads?: ProgressDownload[];
}) => {
  const fraction = stepFraction(step, downloads);
  const shimmer = step.status === 'running' && !idle(step) && !fraction;

  return (
    <div className="absolute left-1/2 top-[22px] h-1 w-full overflow-hidden rounded-full bg-gray-700 sm:top-[26px]">
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
    counts?: string;
    failed?: string;
    waiting?: string;
  };
}

// One equal column per step: the icon on the line, then label, count or percent,
// time and estimate, one short line each so neighbours never collide; six
// columns fit a phone at 10px, longer values truncate rather than overflow
const ProgressStepper = ({
  steps,
  downloads,
  label,
  stats,
}: ProgressStepperProps) => (
  <ol className="flex">
    {steps.map((step, i) => {
      const { percent, time, estimate, range, counts, failed, waiting } =
        stats(step);
      const running = step.status === 'running';
      const fraction = running ? stepFraction(step, downloads) : undefined;
      return (
        <li
          key={step.key}
          className="relative flex min-w-0 flex-1 flex-col items-center text-center text-[10px] tabular-nums leading-tight sm:text-xs"
        >
          {i < steps.length - 1 && (
            <Connector step={step} downloads={downloads} />
          )}
          <div className="relative flex h-12 items-center sm:h-14">
            {/* Opaque behind the translucent circles, so the line stops at the icon */}
            <div className="rounded-full bg-gray-800">
              <div
                className={`relative flex items-center justify-center overflow-hidden rounded-full transition-all duration-500 ${
                  running
                    ? 'h-12 w-12 sm:h-14 sm:w-14'
                    : 'h-9 w-9 sm:h-10 sm:w-10'
                } ${circleClass[step.status]}`}
              >
                {fraction !== undefined && (
                  <div
                    className="absolute inset-x-0 bottom-0 bg-indigo-500 transition-[height] duration-700 ease-out"
                    style={{ height: `${fraction * 100}%` }}
                  />
                )}
                <StepGraphic
                  step={step}
                  downloads={downloads}
                  className={`relative ${
                    running ? 'h-10 w-10 sm:h-12 sm:w-12' : 'h-5 w-5'
                  }`}
                />
              </div>
            </div>
          </div>
          <span
            className={`mt-1 w-full break-words font-medium ${labelClass[step.status]}`}
          >
            {label(step)}
          </span>
          {counts ? (
            <span className="w-full truncate font-semibold text-gray-200">
              {counts}
            </span>
          ) : (
            percent !== undefined && (
              <span className="font-semibold text-gray-200">{percent}%</span>
            )
          )}
          {failed && (
            <span className="mt-0.5 max-w-full truncate rounded-full bg-red-600/20 px-1.5 text-[10px] font-semibold leading-4 text-red-300">
              {failed}
            </span>
          )}
          {time && (
            <span className="w-full truncate text-gray-400">{time}</span>
          )}
          {waiting && (
            <span className="w-full truncate text-yellow-500">{waiting}</span>
          )}
          {estimate && (
            <span className="w-full truncate text-gray-500">{estimate}</span>
          )}
          {range && (
            <span className="hidden w-full truncate text-gray-600 sm:block">
              {range}
            </span>
          )}
        </li>
      );
    })}
  </ol>
);

export default ProgressStepper;
