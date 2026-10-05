import { MediaRequestStatus } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import type { RequestFailureKind } from '@server/entity/MediaRequest';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { LessThanOrEqual } from 'typeorm';

export interface RequestFailure {
  kind: RequestFailureKind;
  reason: string;
}

export const RETRY_BACKOFF_MINUTES = [5, 15, 60, 360];

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

const TRANSIENT_MESSAGE = /socket hang up|timeout of \d+ms exceeded/i;

const MAX_REASON_LENGTH = 255;

interface ErrorLike {
  message?: string;
  code?: string;
  cause?: unknown;
  response?: { status?: number; data?: unknown };
}

const responseDetail = (data: unknown): string | undefined => {
  if (typeof data === 'string') {
    return data;
  }
  if (Array.isArray(data)) {
    return data[0]?.errorMessage ?? data[0]?.message;
  }
  if (data && typeof data === 'object') {
    const { message, error } = data as { message?: unknown; error?: unknown };
    if (typeof message === 'string') return message;
    if (typeof error === 'string') return error;
  }
  return undefined;
};

/**
 * Network errors and HTTP 5xx/429 are transient, everything else (4xx,
 * validation errors, missing configuration) needs an admin and is permanent.
 * Servarr clients wrap the axios error in `cause`, so the whole chain is walked.
 */
export const classifyRequestError = (error: unknown): RequestFailure => {
  const top = error as ErrorLike | undefined;
  const topMessage = top?.message ?? String(error);

  for (
    let e = top, depth = 0;
    e && typeof e === 'object' && depth < 10;
    e = e.cause as ErrorLike | undefined, depth++
  ) {
    const status = e.response?.status;
    if (status) {
      const detail = responseDetail(e.response?.data);
      return {
        kind: status >= 500 || status === 429 ? 'transient' : 'permanent',
        reason:
          `${topMessage}: HTTP ${status}${detail ? ` - ${detail}` : ''}`.slice(
            0,
            MAX_REASON_LENGTH
          ),
      };
    }
    if (
      (e.code && TRANSIENT_ERROR_CODES.has(e.code)) ||
      TRANSIENT_MESSAGE.test(e.message ?? '')
    ) {
      const code = e.code ?? e.message ?? '';
      return {
        kind: 'transient',
        reason: (topMessage.includes(code)
          ? topMessage
          : `${topMessage}: ${code}`
        ).slice(0, MAX_REASON_LENGTH),
      };
    }
  }

  return { kind: 'permanent', reason: topMessage.slice(0, MAX_REASON_LENGTH) };
};

export const retryDelayMs = (retryCount: number): number =>
  RETRY_BACKOFF_MINUTES[
    Math.min(retryCount, RETRY_BACKOFF_MINUTES.length - 1)
  ] *
  60 *
  1000;

/**
 * Marks the request FAILED and schedules the next automatic retry when the
 * failure is transient and attempts remain.
 *
 * @returns whether admins should be notified: on the first failure (as
 * upstream does) and once more when automatic retries stop
 */
export const applyRequestFailure = (
  request: MediaRequest,
  failure: RequestFailure
): boolean => {
  const { autoRetryFailedRequests, autoRetryMaxAttempts } = getSettings().main;
  const retryCount = request.retryCount ?? 0;

  request.status = MediaRequestStatus.FAILED;
  request.failureReason = failure.reason;
  request.failureKind = failure.kind;
  request.nextRetryAt =
    failure.kind === 'transient' &&
    autoRetryFailedRequests &&
    retryCount < autoRetryMaxAttempts
      ? new Date(Date.now() + retryDelayMs(retryCount))
      : null;

  return retryCount === 0 || !request.nextRetryAt;
};

/**
 * Re-approves a failed request, which makes the request subscriber send it
 * to Radarr/Sonarr again. Manual retries start a fresh retry budget.
 */
export const retryFailedRequest = async (
  request: MediaRequest,
  options: { modifiedBy?: User; automatic?: boolean } = {}
): Promise<MediaRequest> => {
  request.status = MediaRequestStatus.APPROVED;
  request.retryCount = options.automatic ? (request.retryCount ?? 0) + 1 : 0;
  if (options.modifiedBy) {
    request.modifiedBy = options.modifiedBy;
  }
  return getRepository(MediaRequest).save(request);
};

export const retryFailedRequests = async (): Promise<number> => {
  if (!getSettings().main.autoRetryFailedRequests) {
    return 0;
  }

  const requests = await getRepository(MediaRequest).find({
    where: {
      status: MediaRequestStatus.FAILED,
      failureKind: 'transient',
      nextRetryAt: LessThanOrEqual(new Date()),
    },
  });

  for (const request of requests) {
    logger.info(`Retrying failed request (attempt ${request.retryCount + 1})`, {
      label: 'Request Retry',
      requestId: request.id,
      failureReason: request.failureReason,
    });
    try {
      await retryFailedRequest(request, { automatic: true });
    } catch (e) {
      logger.error('Failed to retry request', {
        label: 'Request Retry',
        requestId: request.id,
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return requests.length;
};
