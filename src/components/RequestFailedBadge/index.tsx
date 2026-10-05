import Badge from '@app/components/Common/Badge';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestFailedBadge', {
  failedReason: 'Failed: {reason}',
  retryingAt: 'Retrying at {time}',
});

interface RequestFailedBadgeProps {
  request: Pick<MediaRequest, 'failureReason' | 'nextRetryAt'>;
  href?: string;
}

const RequestFailedBadge = ({ request, href }: RequestFailedBadgeProps) => {
  const intl = useIntl();
  const badge = (
    <Badge badgeType="danger" href={href}>
      {intl.formatMessage(globalMessages.failed)}
    </Badge>
  );

  if (!request.failureReason && !request.nextRetryAt) {
    return badge;
  }

  return (
    <span className="inline-flex min-w-0 max-w-full flex-col items-start gap-1">
      {badge}
      {request.failureReason && (
        <span
          className="max-w-full truncate text-xs text-red-300"
          title={request.failureReason}
        >
          {intl.formatMessage(messages.failedReason, {
            reason: request.failureReason,
          })}
        </span>
      )}
      {request.nextRetryAt && (
        <span className="text-xs text-gray-400">
          {intl.formatMessage(messages.retryingAt, {
            time: intl.formatDate(request.nextRetryAt, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            }),
          })}
        </span>
      )}
    </span>
  );
};

export default RequestFailedBadge;
