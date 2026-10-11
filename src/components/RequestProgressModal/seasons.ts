import type {
  ProgressSeason,
  ProgressStep,
} from '@server/interfaces/api/progressInterfaces';
import { waitingForRelease } from './ProgressScene';

// The step a season row names: the first not done, else Ready
export const seasonStep = (steps: ProgressStep[]): ProgressStep =>
  steps.find((s) => s.status !== 'done') ?? steps[steps.length - 1];

// Expanded by default: the first season on its way, else the first. Seasons that failed, wait
// for approval or a release, are not released or are done are not on their way.
export const defaultSeason = (seasons: ProgressSeason[]): ProgressSeason =>
  seasons.find((s) => {
    const step = s.steps && seasonStep(s.steps);
    return (
      step?.status === 'running' &&
      step.key !== 'requested' &&
      !waitingForRelease(step)
    );
  }) ?? seasons[0];
