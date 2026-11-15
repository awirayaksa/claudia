/**
 * Under the composer while Task is on: which workspace folder the task works
 * in. By default the chat's folder (from an earlier task), else a new one
 * under tasks/; or any folder of the workspace (top level, or under tasks/).
 */
import { useTranslation } from 'react-i18next';
import { useWorkspaceFilesQuery } from '../api/rtk-api';

export function TaskFolderPicker({ value, chatFolder, onChange }: { value: string; chatFolder?: string; onChange: (folder: string) => void }) {
  const { t } = useTranslation();
  const { data: root } = useWorkspaceFilesQuery('');
  const hasTasks = !!root?.entries.some((e) => e.type === 'directory' && e.path === 'tasks');
  const { data: tasks } = useWorkspaceFilesQuery('tasks', { skip: !hasTasks });
  const folders = [
    ...(root?.entries ?? []).filter((e) => e.type === 'directory' && e.path !== 'tasks'),
    ...(tasks?.entries ?? []).filter((e) => e.type === 'directory'),
  ].map((e) => e.path);
  const options = [...new Set([...(chatFolder ? [chatFolder] : []), ...folders])].filter((f) => f !== chatFolder);
  return (
    <label className="mb-1.5 flex items-center gap-2 text-xs text-text-secondary" data-testid="task-folder">
      <span>{t('task.folder')}</span>
      <select
        className="max-w-[20rem] rounded border border-border bg-background px-1.5 py-0.5 text-text-primary"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t('task.folder')}
      >
        <option value="">{chatFolder ? t('task.folderSame', { folder: chatFolder }) : t('task.folderNew')}</option>
        {options.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </label>
  );
}
