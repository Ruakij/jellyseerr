import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Table from '@app/components/Common/Table';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type {
  ProgressSampleStats,
  RequestProgressStatsResponse,
} from '@server/interfaces/api/progressInterfaces';
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
  estimatePercentile: 'Estimate Percentile',
  estimatePercentileTip:
    'Duration shown as estimate: the share of past requests that were at least this fast',
  showConfidenceInterval: 'Show Confidence Interval',
  showConfidenceIntervalTip:
    'Show the 95% confidence interval of the estimates as a range',
  samples: 'Samples',
  samplesDescription:
    'Measured durations per step, with the 95% confidence interval of each percentile in brackets.',
  step: 'Step',
  historyCount: 'Arr History',
  localCount: 'Local',
  noInterval: 'too few samples for an interval',
  noServers: 'No Radarr or Sonarr servers configured.',
  searching: 'Searching',
  grabbed: 'Grabbed',
  importing: 'Downloading and Importing',
  inJellyfin: 'In Media Server',
  playable: 'Playable',
  total: 'Total (End to End)',
});

const PERCENTILES = [50, 90, 95, 99] as const;
const STEPS = [
  'searching',
  'grabbed',
  'importing',
  'inJellyfin',
  'playable',
] as const;

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
}

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
  const { data: stats, mutate: revalidateStats } =
    useSWR<RequestProgressStatsResponse>(
      '/api/v1/settings/request-progress/stats'
    );

  const count = Yup.number()
    .typeError(intl.formatMessage(messages.validationNumber))
    .required(intl.formatMessage(messages.validationNumber))
    .integer(intl.formatMessage(messages.validationNumber))
    .min(0, intl.formatMessage(messages.validationNumber));
  const schema = Yup.object().shape(
    Object.fromEntries(fields.map((field) => [field, count]))
  );

  const statCells = (sample: ProgressSampleStats) =>
    PERCENTILES.map((p) => {
      const stat = sample.percentiles[p];
      return (
        <Table.TD key={p}>
          {stat ? (
            <>
              {formatDuration(stat.valueMs)}
              <span className="block text-xs text-gray-400">
                {stat.rangeMs
                  ? `(${formatDuration(stat.rangeMs[0])} - ${formatDuration(
                      stat.rangeMs[1]
                    )})`
                  : `(${intl.formatMessage(messages.noInterval)})`}
              </span>
            </>
          ) : (
            '-'
          )}
        </Table.TD>
      );
    });

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
          initialValues={{
            ...(Object.fromEntries(
              fields.map((field) => [field, data?.[field] ?? 0])
            ) as Record<(typeof fields)[number], number>),
            estimatePercentile: String(data?.estimatePercentile ?? 90),
            showConfidenceInterval: data?.showConfidenceInterval ?? false,
          }}
          enableReinitialize
          validationSchema={schema}
          onSubmit={async (values) => {
            try {
              await axios.post('/api/v1/settings/request-progress', {
                ...Object.fromEntries(
                  fields.map((field) => [field, Number(values[field])])
                ),
                estimatePercentile: Number(values.estimatePercentile),
                showConfidenceInterval: values.showConfidenceInterval,
              });
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
              revalidateStats();
            }
          }}
        >
          {({
            errors,
            touched,
            isSubmitting,
            isValid,
            values,
            setFieldValue,
          }) => (
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
              <div className="form-row">
                <label htmlFor="estimatePercentile" className="text-label">
                  <span className="mr-2">
                    {intl.formatMessage(messages.estimatePercentile)}
                  </span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.estimatePercentileTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      as="select"
                      id="estimatePercentile"
                      name="estimatePercentile"
                    >
                      {PERCENTILES.map((p) => (
                        <option key={p} value={String(p)}>
                          p{p}
                        </option>
                      ))}
                    </Field>
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label
                  htmlFor="showConfidenceInterval"
                  className="checkbox-label"
                >
                  <span className="mr-2">
                    {intl.formatMessage(messages.showConfidenceInterval)}
                  </span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.showConfidenceIntervalTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="showConfidenceInterval"
                    name="showConfidenceInterval"
                    onChange={() => {
                      setFieldValue(
                        'showConfidenceInterval',
                        !values.showConfidenceInterval
                      );
                    }}
                  />
                </div>
              </div>
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
      <div className="mb-6 mt-10">
        <h3 className="heading">{intl.formatMessage(messages.samples)}</h3>
        <p className="description">
          {intl.formatMessage(messages.samplesDescription)}
        </p>
      </div>
      <div className="section">
        {stats?.servers.length === 0 && (
          <p className="description">
            {intl.formatMessage(messages.noServers)}
          </p>
        )}
        {stats?.servers.map((server) => (
          <div key={server.serverKey} className="mb-8">
            <h4 className="text-lg font-bold text-white">{server.name}</h4>
            <Table>
              <thead>
                <tr>
                  <Table.TH>{intl.formatMessage(messages.step)}</Table.TH>
                  <Table.TH>
                    {intl.formatMessage(messages.historyCount)}
                  </Table.TH>
                  <Table.TH>{intl.formatMessage(messages.localCount)}</Table.TH>
                  {PERCENTILES.map((p) => (
                    <Table.TH key={p}>p{p}</Table.TH>
                  ))}
                </tr>
              </thead>
              <Table.TBody>
                {[
                  ...STEPS.map((step) => [step, server.steps[step]] as const),
                  ['total', server.total] as const,
                ].map(([key, sample]) => (
                  <tr key={key}>
                    <Table.TD>{intl.formatMessage(messages[key])}</Table.TD>
                    <Table.TD>{sample.historyCount}</Table.TD>
                    <Table.TD>{sample.localCount}</Table.TD>
                    {statCells(sample)}
                  </tr>
                ))}
              </Table.TBody>
            </Table>
          </div>
        ))}
      </div>
    </>
  );
};

export default SettingsRequestProgress;
