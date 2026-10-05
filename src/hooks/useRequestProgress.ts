import type { RequestProgress } from '@server/interfaces/api/progressInterfaces';
import { useEffect, useState } from 'react';

const RETRY_MS = 5000;

const useRequestProgress = (
  mediaId: number | undefined,
  is4k: boolean,
  enabled = true
): RequestProgress | undefined => {
  const [progress, setProgress] = useState<RequestProgress>();

  useEffect(() => {
    setProgress(undefined);
    if (!mediaId || !enabled) {
      return;
    }

    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      source = new EventSource(
        `/api/v1/media/${mediaId}/progress?is4k=${is4k}`
      );
      source.addEventListener('progress', (e) => {
        setProgress(JSON.parse((e as MessageEvent<string>).data));
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
  }, [mediaId, is4k, enabled]);

  return progress;
};

export default useRequestProgress;
