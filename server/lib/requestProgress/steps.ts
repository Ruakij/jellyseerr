// Apart from stepStats, which loads the database entities, whose import chain reaches the tracker.
export const PROGRESS_STEPS = [
  'searching',
  'grabbed',
  'importing',
  'inJellyfin',
  'playable',
] as const;

export type ProgressStep = (typeof PROGRESS_STEPS)[number];
