import {
  ArrowDownIcon,
  CheckIcon,
  FilmIcon,
  FolderArrowDownIcon,
  MagnifyingGlassIcon,
  PlayIcon,
} from '@heroicons/react/24/solid';
import type {
  ProgressDownload,
  ProgressStep,
  ProgressStepKey,
} from '@server/interfaces/api/progressInterfaces';

// Overall share downloaded, undefined while no size is known
export const downloadFraction = (downloads?: ProgressDownload[]) => {
  const size = (downloads ?? []).reduce((sum, d) => sum + d.size, 0);
  const left = (downloads ?? []).reduce((sum, d) => sum + d.sizeLeft, 0);
  return size > 0 ? (size - left) / size : undefined;
};

const stepIcons: Record<ProgressStepKey, typeof CheckIcon> = {
  requested: CheckIcon,
  searching: MagnifyingGlassIcon,
  grabbed: ArrowDownIcon,
  importing: FolderArrowDownIcon,
  inJellyfin: FilmIcon,
  playable: PlayIcon,
};

const DARK = '#111827';
const delay = (i: number, step: number) => ({
  animationDelay: `${i * step}s`,
});

// Animated scenes; keyframes and the .ps-* classes live in globals.css
const scenes: Record<
  ProgressStepKey,
  (props: { fraction?: number }) => React.ReactNode
> = {
  requested: () => (
    <>
      <path
        className="ps-trail"
        d="M4 44q8-12 16-12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity=".5"
      />
      <g className="ps-fly">
        <path d="M8 26 42 10 32 40 24 30z" fill="currentColor" />
        <path d="M24 30 42 10" stroke={DARK} strokeOpacity=".4" />
      </g>
    </>
  ),
  searching: () => (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect
            className="ps-card"
            style={delay(i, 0.6)}
            x={6 + i * 14}
            y="24"
            width="10"
            height="12"
            rx="2"
            fill="currentColor"
            opacity=".6"
          />
          <circle
            className="ps-fall"
            style={delay(i, 0.6)}
            cx={11 + i * 14}
            cy="40"
            r="1.8"
            fill="currentColor"
          />
        </g>
      ))}
      <g className="ps-glide">
        <circle
          cx="11"
          cy="12"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        />
        <path
          d="m15.5 16.5 4 4"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>
    </>
  ),
  grabbed: ({ fraction }) => (
    <>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          className="ps-stream"
          style={delay(i, 0.4)}
          x={14 + i * 8}
          y="6"
          width="4"
          height="4"
          rx="1"
          fill="currentColor"
        />
      ))}
      <rect
        x="8"
        y="26"
        width="32"
        height="16"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      {fraction === undefined ? (
        <rect
          className="ps-slosh"
          x="11"
          y="29"
          width="26"
          height="10"
          fill="currentColor"
          opacity=".6"
        />
      ) : (
        <rect
          x="11"
          y={39 - 10 * fraction}
          width="26"
          height={10 * fraction}
          fill="currentColor"
          opacity=".6"
          style={{ transition: 'all .7s ease-out' }}
        />
      )}
    </>
  ),
  importing: () => (
    <>
      <path d="M6 14h12l4 4h20v22H6z" fill="currentColor" opacity=".45" />
      <g className="ps-file">
        <rect
          x="18"
          y="6"
          width="12"
          height="15"
          rx="1.5"
          fill="currentColor"
        />
        <path d="M21 11h6m-6 4h6" stroke={DARK} strokeOpacity=".4" />
      </g>
      <path className="ps-lid" d="M6 24h36v16H6z" fill="currentColor" />
      <rect
        className="ps-tag"
        x="29"
        y="29"
        width="9"
        height="5"
        rx="1.5"
        fill={DARK}
        opacity=".6"
      />
    </>
  ),
  inJellyfin: () => (
    <>
      <g className="ps-spin">
        <circle cx="14" cy="22" r="10" fill="currentColor" />
        {[
          [14, 17],
          [19, 22],
          [14, 27],
          [9, 22],
        ].map(([cx, cy]) => (
          <circle
            key={`${cx}-${cy}`}
            cx={cx}
            cy={cy}
            r="2.2"
            fill={DARK}
            opacity=".7"
          />
        ))}
      </g>
      <path d="M26 40h18" stroke="currentColor" strokeWidth="2.5" />
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          className="ps-slot"
          style={delay(i, 0.4)}
          x={27 + i * 6}
          y="27"
          width="4.5"
          height="11"
          rx=".8"
          fill="currentColor"
        />
      ))}
    </>
  ),
  playable: () => (
    <>
      <circle
        className="ps-ripple"
        cx="24"
        cy="24"
        r="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0"
      />
      <g className="ps-grow">
        <circle cx="24" cy="24" r="16" fill="currentColor" />
        <path d="M20 16v16l12-8z" fill={DARK} />
      </g>
    </>
  ),
};

interface StepGraphicProps {
  step: ProgressStep;
  downloads?: ProgressDownload[];
  className?: string;
}

// Animated scene while a step runs (and once when ready), its icon otherwise
const StepGraphic = ({ step, downloads, className }: StepGraphicProps) => {
  if (
    step.status === 'running' ||
    (step.key === 'playable' && step.status === 'done')
  ) {
    const Scene = scenes[step.key];
    return (
      <svg viewBox="0 0 48 48" className={`ps ${className ?? ''}`}>
        <Scene fraction={downloadFraction(downloads)} />
      </svg>
    );
  }
  const Icon = stepIcons[step.key];
  return <Icon className={className} />;
};

export default StepGraphic;
