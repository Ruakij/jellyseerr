import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { RequestProgressSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsRequestProgress', {
  toastSettingsSuccess: 'Settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving settings.',
  requestProgress: 'Request Progress',
  requestProgressSettings: 'Request Progress Settings',
  requestProgressSettingsDescription:
    'Configure which measured durations the request progress estimates are based on.',
  historyMaxAgeDays: 'Arr History Maximum Age (Days)',
  historyMaxAgeDaysTip:
    'Durations derived from the Radarr/Sonarr history; 0 for no limit',
  historyMaxSamples: 'Arr History Maximum Samples per Step',
  historyMaxSamplesTip: 'Newest durations kept per step; 0 for no limit',
  localMaxAgeDays: 'Local Maximum Age (Days)',
  localMaxAgeDaysTip: 'Durations measured by Seerr itself; 0 for no limit',
  localMaxSamples: 'Local Maximum Samples per Step',
  localMaxSamplesTip: 'Newest durations kept per step; 0 for no limit',
  validationNumber: 'You must provide a whole number of 0 or more',
});

const fields = [
  'historyMaxAgeDays',
  'historyMaxSamples',
  'localMaxAgeDays',
  'localMaxSamples',
] as const;

const SettingsRequestProgress = () => {
  const { addToast } = useToasts();
  const intl = useIntl();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<RequestProgressSettings>('/api/v1/settings/request-progress');

  const count = Yup.number()
    .typeError(intl.formatMessage(messages.validationNumber))
    .required(intl.formatMessage(messages.validationNumber))
    .integer(intl.formatMessage(messages.validationNumber))
    .min(0, intl.formatMessage(messages.validationNumber));
  const schema = Yup.object().shape(
    Object.fromEntries(fields.map((field) => [field, count]))
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.requestProgress),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.requestProgressSettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.requestProgressSettingsDescription)}
        </p>
      </div>
      <div className="section">
        <Formik
          initialValues={Object.fromEntries(
            fields.map((field) => [field, data?.[field] ?? 0])
          )}
          enableReinitialize
          validationSchema={schema}
          onSubmit={async (values) => {
            try {
              await axios.post(
                '/api/v1/settings/request-progress',
                Object.fromEntries(
                  fields.map((field) => [field, Number(values[field])])
                )
              );
              addToast(intl.formatMessage(messages.toastSettingsSuccess), {
                autoDismiss: true,
                appearance: 'success',
              });
            } catch {
              addToast(intl.formatMessage(messages.toastSettingsFailure), {
                autoDismiss: true,
                appearance: 'error',
              });
            } finally {
              revalidate();
            }
          }}
        >
          {({ errors, touched, isSubmitting, isValid }) => (
            <Form className="section" data-testid="settings-request-progress">
              {fields.map((field) => (
                <div className="form-row" key={field}>
                  <label htmlFor={field} className="text-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages[field])}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages[`${field}Tip`])}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      id={field}
                      name={field}
                      type="text"
                      inputMode="numeric"
                      className="short"
                    />
                  </div>
                  {errors[field] &&
                    touched[field] &&
                    typeof errors[field] === 'string' && (
                      <div className="error">{errors[field]}</div>
                    )}
                </div>
              ))}
              <div className="actions">
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || !isValid}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {isSubmitting
                          ? intl.formatMessage(globalMessages.saving)
                          : intl.formatMessage(globalMessages.save)}
                      </span>
                    </Button>
                  </span>
                </div>
              </div>
            </Form>
          )}
        </Formik>
      </div>
    </>
  );
};

export default SettingsRequestProgress;
