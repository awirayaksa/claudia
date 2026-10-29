/** The writing style for the next messages, next to the composer's other buttons. */
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Menu } from '../components/Menu';
import { PenIcon } from '../components/icons';
import { useStylesQuery } from '../api/rtk-api';

export function StylePicker({ value, onChange, disabled }: { value: string | null; onChange: (id: string) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useStylesQuery();
  const list = data?.styles ?? [];
  const current = list.find((s) => s.id === (value ?? 'normal'));
  const custom = list.filter((s) => s.scope !== 'builtin');
  const item = (s: (typeof list)[number]) => ({ label: s.name, checked: s.id === (value ?? 'normal'), onSelect: () => onChange(s.id) });
  if (disabled) return null;
  return (
    <span data-testid="style-picker">
      <Menu
        label={t('styles.pick')}
        placement="above"
        align="left"
        trigger={
          <span className="flex items-center gap-1 text-xs">
            <PenIcon />
            {current && current.id !== 'normal' && <span className="max-w-[8rem] truncate">{current.name}</span>}
          </span>
        }
        items={[
          { heading: t('styles.title') },
          ...list.filter((s) => s.scope === 'builtin').map(item),
          ...(custom.length ? (['separator', ...custom.map(item)] as const) : []),
          'separator',
          { label: t('styles.manage'), onSelect: () => navigate('/settings?tab=styles') },
        ]}
      />
    </span>
  );
}
