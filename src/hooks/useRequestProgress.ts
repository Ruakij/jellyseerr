import type { RequestProgress } from '@server/interfaces/api/progressInterfaces';
import { useEffect, useState } from 'react';

const RETRY_MS = 5000;

// The same request fails again: a retry would spin forever
const permanent = (status: number) =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

const useRequestProgress = (
  mediaId: number | undefined,
  is4k: boolean,
  // a past run of this request, unless the live run covers it
  requestId?: number
): { progress?: RequestProgress; error: boolean } => {
  const [progress, setProgress] = useState<RequestProgress>();
  const [error, setError] = useState(false);

  useEffect(() => {
    setProgress(undefined);
    setError(false);
    if (!mediaId) {
      return;
    }

    const url = `/api/v1/media/${mediaId}/progress?is4k=${is4k}${
      requestId ? `&requestId=${requestId}` : ''
    }`;
    const aborter = new AbortController();
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      source = new EventSource(url);
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
        // EventSource retries network drops itself but gives up on HTTP errors, without their status
        if (source?.readyState !== EventSource.CLOSED) return;
        fetch(url, { signal: aborter.signal })
          .then((res) => {
            void res.body?.cancel();
            if (permanent(res.status)) setError(true);
            else retry = setTimeout(connect, RETRY_MS);
          })
          .catch(() => {
            if (!aborter.signal.aborted) retry = setTimeout(connect, RETRY_MS);
          });
      };
    };
    connect();

    return () => {
      aborter.abort();
      clearTimeout(retry);
      source?.close();
    };
  }, [mediaId, is4k, requestId]);

  return { progress, error };
};

export default useRequestProgress;
