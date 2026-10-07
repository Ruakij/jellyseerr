import StepGraphic, {
  waitingForRelease,
} from '@app/components/RequestProgressModal/ProgressScene';
import type { ProgressStep } from '@server/interfaces/api/progressInterfaces';
import { useState } from 'react';

const circleClass: Record<ProgressStep['status'], string> = {
  done: 'bg-green-600 text-white',
  running: 'border-2 border-indigo-500 bg-indigo-500/10 text-indigo-200',
  failed: 'bg-red-600 text-white',
  pending: 'border border-gray-600 text-gray-600',
};

// Amber and still: nothing may suggest the next step is close
const WAITING_CIRCLE =
  'border-2 border-amber-500 bg-amber-500/10 text-amber-300';

const labelClass: Record<ProgressStep['status'], string> = {
  done: 'text-gray-200',
  running: 'text-white',
  failed: 'text-red-400',
  pending: 'text-gray-500',
};

// Share of the units past a running step
const stepFraction = (step: ProgressStep): number | undefined => {
  if (step.status === 'done') return 1;
  if (step.status !== 'running') return undefined;
  return step.progress;
};

const SWEEP_MS = 4000;
const LINE = 'absolute top-[22px] h-1 rounded-full sm:top-[26px]';

// A window onto one sweep spanning the whole track; the shared phase lines up the windows of
// neighbouring steps into one continuous sweep
const Sweep = ({ index, count }: { index: number; count: number }) => {
  const [delay] = useState(() => -(performance.now() % SWEEP_MS));
  return (
    <div
      className="absolute inset-y-0"
      style={{ left: `${-index * 100}%`, width: `${(count - 1) * 100}%` }}
    >
      <div
        className="ps-sweep absolute inset-y-0 left-0 w-1/5 bg-gradient-to-r from-transparent via-indigo-500 to-transparent motion-reduce:w-full motion-reduce:via-indigo-500/40"
        style={{ animationDelay: `${delay}ms` }}
      />
    </div>
  );
};

// Half the circle widths, h-12/h-14 running and h-9/h-10 otherwise
const LEFT_EDGE = { big: 'left-6 sm:left-7', small: 'left-[18px] sm:left-5' };
const RIGHT_EDGE = {
  big: 'right-6 sm:right-7',
  small: 'right-[18px] sm:right-5',
};
const edge = (step: ProgressStep) =>
  step.status === 'running' ? 'big' : 'small';

// The line from the center of a step to the center of the next one: grey, the green share
// of the units past the step, and the sweep while the step runs
const Connector = ({
  step,
  next,
  index,
  count,
}: {
  step: ProgressStep;
  next: ProgressStep;
  index: number;
  count: number;
}) => {
  // Approval is no work in progress
  const sweeping = step.status === 'running' && step.key !== 'requested';
  return (
    <div className={`${LINE} left-1/2 w-full overflow-hidden bg-gray-700`}>
      {sweeping && <Sweep index={index} count={count} />}
      {/* The circles cover the ends of the line, so the share fills the visible part between them */}
      <div
        className={`absolute inset-y-0 transition-[left,right] duration-500 ${LEFT_EDGE[edge(step)]} ${RIGHT_EDGE[edge(next)]}`}
      >
        <div
          className="h-full bg-green-600 transition-[width] duration-700 ease-out"
          style={{ width: `${(stepFraction(step) ?? 0) * 100}%` }}
        />
      </div>
    </div>
  );
};

interface ProgressStepperProps {
  steps: ProgressStep[];
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
const ProgressStepper = ({ steps, label, stats }: ProgressStepperProps) => {
  return (
    <ol className="relative flex">
      {steps.map((step, i) => {
        const {
          percent,
          time,
          estimate,
          range,
          counts,
          failed,
          waiting: waitingFor,
        } = stats(step);
        const running = step.status === 'running';
        const waiting = waitingForRelease(step);
        const fraction = running ? stepFraction(step) : undefined;
        return (
          <li
            key={step.key}
            className="relative flex min-w-0 flex-1 flex-col items-center text-center text-[10px] tabular-nums leading-tight sm:text-xs"
          >
            {i < steps.length - 1 && (
              <Connector
                step={step}
                next={steps[i + 1]}
                index={i}
                count={steps.length}
              />
            )}
            <div className="relative flex h-12 items-center sm:h-14">
              {/* Opaque behind the translucent circles, so the line stops at the icon */}
              <div className="rounded-full bg-gray-800">
                <div
                  className={`relative flex items-center justify-center overflow-hidden rounded-full transition-all duration-500 ${
                    running
                      ? 'h-12 w-12 sm:h-14 sm:w-14'
                      : 'h-9 w-9 sm:h-10 sm:w-10'
                  } ${waiting ? WAITING_CIRCLE : circleClass[step.status]}`}
                >
                  {fraction !== undefined && (
                    <div
                      className="absolute inset-x-0 bottom-0 bg-indigo-500 transition-[height] duration-700 ease-out"
                      style={{ height: `${fraction * 100}%` }}
                    />
                  )}
                  <StepGraphic
                    step={step}
                    className={`relative ${
                      waiting
                        ? 'h-6 w-6 sm:h-7 sm:w-7'
                        : running
                          ? 'h-10 w-10 sm:h-12 sm:w-12'
                          : 'h-5 w-5'
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
            {waitingFor && (
              <span className="w-full truncate text-yellow-500">
                {waitingFor}
              </span>
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
};

export default ProgressStepper;
