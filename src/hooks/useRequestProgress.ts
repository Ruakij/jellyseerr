import type { RequestProgress } from '@server/interfaces/api/progressInterfaces';
import { useEffect, useState } from 'react';

const RETRY_MS = 5000;

const useRequestProgress = (
  mediaId: number | undefined,
  is4k: boolean,
  // a past run of this request, unless the live run covers it
  requestId?: number
): RequestProgress | undefined => {
  const [progress, setProgress] = useState<RequestProgress>();

  useEffect(() => {
    setProgress(undefined);
    if (!mediaId) {
      return;
    }

    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      source = new EventSource(
        `/api/v1/media/${mediaId}/progress?is4k=${is4k}${
          requestId ? `&requestId=${requestId}` : ''
        }`
      );
      source.addEventListener('progress', (e) => {
        const next: RequestProgress = JSON.parse(
          (e as MessageEvent<string>).data
        );
        // the stream sends the timeline only when it changed
        setProgress((prev) =>
          next.timeline === undefined
            ? { ...next, timeline: prev?.timeline }
            : next
        );
      });
      source.onerror = () => {
        // EventSource retries network drops itself but gives up on HTTP errors
        if (source?.readyState === EventSource.CLOSED) {
          retry = setTimeout(connect, RETRY_MS);
        }
      };
    };
    connect();

    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [mediaId, is4k, requestId]);

  return progress;
};

export default useRequestProgress;
