import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestFailedBadge', {
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
    <Tooltip
      content={
        <>
          {request.failureReason && <div>{request.failureReason}</div>}
          {request.nextRetryAt && (
            <div>
              {intl.formatMessage(messages.retryingAt, {
                time: intl.formatDate(request.nextRetryAt, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                }),
              })}
            </div>
          )}
        </>
      }
    >
      <span>{badge}</span>
    </Tooltip>
  );
};

export default RequestFailedBadge;
