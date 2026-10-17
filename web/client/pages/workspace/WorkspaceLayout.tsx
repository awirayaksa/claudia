import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageFrame, Tabs } from '../../components/PageFrame';

type Section = 'models' | 'prompts' | 'knowledge';

/** /workspace: custom models and the prompt library. */
export function WorkspaceLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const section = (location.pathname.split('/')[2] as Section) || 'models';
  return (
    <PageFrame title={t('workspace.title')}>
      <Tabs<Section>
        value={section}
        onChange={(s) => navigate(`/workspace/${s}`)}
        tabs={[
          { id: 'models', label: t('workspace.models') },
          { id: 'prompts', label: t('workspace.prompts') },
          { id: 'knowledge', label: t('workspace.knowledge') },
        ]}
      />
      <div className="mt-4">
        <Outlet />
      </div>
    </PageFrame>
  );
}
