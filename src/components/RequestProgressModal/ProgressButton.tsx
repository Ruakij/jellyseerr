import Button from '@app/components/Common/Button';
import { RequestProgressTrigger } from '@app/components/RequestProgressModal';
import defineMessages from '@app/utils/defineMessages';
import { ChartBarIcon } from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.RequestProgressModal', {
  progress: 'Progress',
  progress4k: '4K Progress',
});

// The requests the tracker follows: deleted, declined and completed ones leave it
export const ACTIVE_REQUEST = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.FAILED,
];

interface ProgressButtonProps {
  media?: Media;
  subTitle?: string;
}

// One button per variant with an active request, whatever the media status
const ProgressButton = ({ media, subTitle }: ProgressButtonProps) => {
  const intl = useIntl();
  const variants = [false, true].filter((is4k) =>
    media?.requests?.some(
      (r) => r.is4k === is4k && ACTIVE_REQUEST.includes(r.status)
    )
  );

  return (
    <>
      {variants.map((is4k) => (
        <RequestProgressTrigger
          key={String(is4k)}
          mediaId={media?.id}
          is4k={is4k}
          subTitle={subTitle}
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

export default ProgressButton;
