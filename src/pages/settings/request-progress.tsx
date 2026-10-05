import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsRequestProgress from '@app/components/Settings/SettingsRequestProgress';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsRequestProgressPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsRequestProgress />
    </SettingsLayout>
  );
};

export default SettingsRequestProgressPage;
