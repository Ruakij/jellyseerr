import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { RequestProgressTrigger } from '@app/components/RequestProgressModal';
import defineMessages from '@app/utils/defineMessages';
import { ChartBarIcon } from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestProgressModal', {
  progress: 'Progress',
  progress4k: '4K Progress',
  pastProgress: 'Request Progress',
});

// The requests the tracker follows: deleted, declined and completed ones leave it
export const ACTIVE_REQUEST = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.FAILED,
];

interface ProgressButtonProps {
  media?: Media;
}

// One button per variant with an active request or a stored past run, whatever the media status
const ProgressButton = ({ media }: ProgressButtonProps) => {
  const intl = useIntl();
  const variants = [false, true].filter((is4k) =>
    media?.requests?.some(
      (r) =>
        r.is4k === is4k &&
        (ACTIVE_REQUEST.includes(r.status) || r.hasProgressRun)
    )
  );

  return (
    <>
      {variants.map((is4k) => (
        <RequestProgressTrigger
          key={String(is4k)}
          mediaId={media?.id}
          is4k={is4k}
        >
          {(open) => (
            <Button
              buttonType="ghost"
              aria-haspopup="dialog"
              onClick={open}
              className="ml-2 first:ml-0"
            >
              <ChartBarIcon />
              <span>
                {intl.formatMessage(
                  is4k ? messages.progress4k : messages.progress
                )}
              </span>
            </Button>
          )}
        </RequestProgressTrigger>
      ))}
    </>
  );
};

interface RequestProgressIconProps {
  request: Pick<MediaRequest, 'id' | 'is4k' | 'media' | 'hasProgressRun'>;
  className?: string;
}

// Opens the stored past run of one request
export const RequestProgressIcon = ({
  request,
  className,
}: RequestProgressIconProps) => {
  const intl = useIntl();
  if (!request.hasProgressRun) return null;
  return (
    <RequestProgressTrigger
      mediaId={request.media?.id}
      is4k={request.is4k}
      requestId={request.id}
    >
      {(open) => (
        <Tooltip content={intl.formatMessage(messages.pastProgress)}>
          <Button
            buttonType="ghost"
            buttonSize="sm"
            aria-haspopup="dialog"
            aria-label={intl.formatMessage(messages.pastProgress)}
            onClick={open}
            className={className}
          >
            <ChartBarIcon className="icon-sm" />
          </Button>
        </Tooltip>
      )}
    </RequestProgressTrigger>
  );
};

export default ProgressButton;
