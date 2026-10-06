import { getRepository } from '@server/datasource';
import { RequestProgressRun } from '@server/entity/RequestProgressRun';
import type { RequestProgress } from '@server/interfaces/api/progressInterfaces';

/** Stores the final run for each of its requests, replacing their previous run. */
export async function storeRun(
  progress: RequestProgress,
  requestIds: number[]
): Promise<void> {
  const repo = getRepository(RequestProgressRun);
  const snapshot = JSON.stringify(progress);
  for (const id of requestIds) {
    const run =
      (await repo.findOne({ where: { request: { id } } })) ??
      new RequestProgressRun({
        request: { id } as RequestProgressRun['request'],
      });
    run.is4k = progress.is4k;
    run.finishedAt = new Date(progress.finishedAt ?? Date.now());
    run.snapshot = snapshot;
    await repo.save(run);
  }
}

/** The stored run of the request, or the latest one of the media variant without a request. */
export async function storedRun(
  mediaId: number,
  is4k: boolean,
  requestId?: number
): Promise<RequestProgress | undefined> {
  const run = await getRepository(RequestProgressRun).findOne({
    where: {
      is4k,
      request: { id: requestId, media: { id: mediaId } },
    },
    order: { finishedAt: 'DESC' },
  });
  return (
    run && {
      ...JSON.parse(run.snapshot),
      finishedAt: run.finishedAt.toISOString(),
    }
  );
}
