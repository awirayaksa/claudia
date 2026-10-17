import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSessionQuery } from '../../api/rtk-api';
import { PageFrame, Tabs } from '../../components/PageFrame';

type Section = 'users' | 'groups' | 'connections' | 'tools' | 'knowledge' | 'directory' | 'settings';

export function AdminLayout() {
  const { t } = useTranslation();
  const { data } = useSessionQuery();
  const location = useLocation();
  const navigate = useNavigate();
  if (data?.user?.role !== 'admin') return <Navigate to="/" replace />;

  const section = (location.pathname.split('/')[2] as Section) || 'users';
  return (
    <PageFrame title={t('admin.title')}>
      <Tabs<Section>
        value={section}
        onChange={(s) => navigate(`/admin/${s}`)}
        tabs={[
          { id: 'users', label: t('admin.users') },
          { id: 'groups', label: t('access.groups') },
          { id: 'connections', label: t('admin.connections') },
          { id: 'tools', label: t('admin.tools') },
          { id: 'knowledge', label: t('rag.title') },
          { id: 'directory', label: t('admin.directory') },
          { id: 'settings', label: t('admin.settings') },
        ]}
      />
      <div className="mt-4">
        <Outlet />
      </div>
    </PageFrame>
  );
}
