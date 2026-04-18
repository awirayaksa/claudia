import { useState, useCallback } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import { createSkill, updateSkill, deleteSkill, clearSkillError, setSelectedSkill } from '../../store/slices/skillSlice';
import type { Skill, SkillWritePayload } from '../../types/skill.types';
import { Button } from '../common/Button';

const VALID_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

interface SkillFormState {
  id: string;
  name: string;
  description: string;
  body: string;
}

const emptyForm: SkillFormState = { id: '', name: '', description: '', body: '' };

function deriveId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

interface SkillFormProps {
  initial?: SkillFormState;
  isNew: boolean;
  onSave: (payload: SkillWritePayload) => Promise<void>;
  onCancel: () => void;
  error: string | null;
}

function SkillForm({ initial = emptyForm, isNew, onSave, onCancel, error }: SkillFormProps) {
  const [form, setForm] = useState<SkillFormState>(initial);
  const [idManuallyEdited, setIdManuallyEdited] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleNameChange = (name: string) => {
    setForm((prev) => ({
      ...prev,
      name,
      id: idManuallyEdited ? prev.id : deriveId(name),
    }));
  };

  const handleIdChange = (id: string) => {
    setIdManuallyEdited(true);
    setForm((prev) => ({ ...prev, id }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return 'Name is required.';
    if (!form.id.trim()) return 'ID is required.';
    if (!VALID_ID_PATTERN.test(form.id))
      return 'ID must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.';
    if (!form.body.trim()) return 'Skill body is required.';
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { setValidationError(err); return; }
    setValidationError(null);
    setSaving(true);
    try {
      await onSave({ id: form.id, name: form.name, description: form.description, body: form.body });
    } finally {
      setSaving(false);
    }
  };

  const displayError = validationError || error;

  return (
    <div className="rounded-lg border border-border bg-background p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Code Review"
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">
            ID <span className="text-text-secondary font-normal">(slash command)</span>
          </label>
          <div className="flex items-center gap-1">
            <span className="text-text-secondary text-sm">/</span>
            <input
              type="text"
              value={form.id}
              onChange={(e) => handleIdChange(e.target.value)}
              placeholder="code-review"
              className="flex-1 rounded border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text-primary focus:border-accent focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">Description</label>
        <input
          type="text"
          value={form.description}
          onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
          placeholder="Short description shown in the autocomplete dropdown"
          className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Skill body{' '}
          <span className="text-text-secondary font-normal">
            — use <code className="bg-surface px-1 rounded">{'{{args}}'}</code> where user args should be inserted
          </span>
        </label>
        <textarea
          value={form.body}
          onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
          placeholder={`Please review the following code:\n\n{{args}}`}
          rows={8}
          className="w-full resize-y rounded border border-border bg-surface px-2 py-1.5 font-mono text-sm text-text-primary focus:border-accent focus:outline-none"
        />
      </div>

      {displayError && (
        <p className="text-xs text-error">{displayError}</p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save Skill'}
        </Button>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

type EditMode =
  | { type: 'none' }
  | { type: 'new' }
  | { type: 'edit'; skill: Skill };

export function SkillSettings() {
  const dispatch = useAppDispatch();
  const { skills, error } = useAppSelector((state) => state.skills);

  const builtinSkills = skills.filter((s) => s.builtin);
  const userSkills = skills.filter((s) => !s.builtin);

  const [editMode, setEditMode] = useState<EditMode>({ type: 'none' });
  const [viewingBuiltin, setViewingBuiltin] = useState<Skill | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleCreate = useCallback(
    async (payload: SkillWritePayload) => {
      const result = await dispatch(createSkill(payload));
      if (createSkill.fulfilled.match(result)) {
        setEditMode({ type: 'none' });
      }
    },
    [dispatch]
  );

  const handleUpdate = useCallback(
    async (payload: SkillWritePayload) => {
      const result = await dispatch(updateSkill(payload));
      if (updateSkill.fulfilled.match(result)) {
        setEditMode({ type: 'none' });
        dispatch(setSelectedSkill(null));
      }
    },
    [dispatch]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await dispatch(deleteSkill(id));
      setDeleteConfirm(null);
    },
    [dispatch]
  );

  const handleOpenDir = async () => {
    await window.electron.skills.openDir();
  };

  return (
    <div className="space-y-6" style={{ padding: '22px 28px' }}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Skills</h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            Invoke skills with <code className="bg-surface px-1 rounded">/skill-name</code> in the chat input
          </p>
        </div>
        {editMode.type === 'none' && (
          <Button
            variant="secondary"
            onClick={() => {
              dispatch(clearSkillError());
              setEditMode({ type: 'new' });
            }}
          >
            + New Skill
          </Button>
        )}
      </div>

      {/* New skill form */}
      {editMode.type === 'new' && (
        <SkillForm
          isNew
          onSave={handleCreate}
          onCancel={() => setEditMode({ type: 'none' })}
          error={error}
        />
      )}

      {/* Built-in skills */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          Built-in
        </h4>
        <div className="space-y-1">
          {builtinSkills.map((skill) => (
            <div key={skill.id}>
              <div
                className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2"
              >
                <code className="w-32 shrink-0 font-mono text-xs text-accent">/{skill.id}</code>
                <span className="flex-1 text-sm text-text-primary">{skill.description || skill.name}</span>
                <button
                  className="text-xs text-text-secondary hover:text-text-primary"
                  onClick={() => setViewingBuiltin(viewingBuiltin?.id === skill.id ? null : skill)}
                >
                  {viewingBuiltin?.id === skill.id ? 'Hide' : 'View'}
                </button>
              </div>
              {viewingBuiltin?.id === skill.id && (
                <div className="mx-1 rounded-b-lg border border-t-0 border-border bg-background px-3 py-2">
                  <pre className="whitespace-pre-wrap font-mono text-xs text-text-secondary">{skill.body}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* User skills */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            Your Skills
          </h4>
          <button
            className="text-xs text-text-secondary hover:text-text-primary"
            onClick={handleOpenDir}
          >
            Open Skills Folder
          </button>
        </div>

        {userSkills.length === 0 ? (
          <p className="text-xs text-text-secondary py-2">
            No custom skills yet. Click "New Skill" to create one, or add .md files to the skills folder.
          </p>
        ) : (
          <div className="space-y-1">
            {userSkills.map((skill) => (
              <div key={skill.id}>
                {editMode.type === 'edit' && editMode.skill.id === skill.id ? (
                  <SkillForm
                    initial={{ id: skill.id, name: skill.name, description: skill.description, body: skill.body }}
                    isNew={false}
                    onSave={handleUpdate}
                    onCancel={() => setEditMode({ type: 'none' })}
                    error={error}
                  />
                ) : (
                  <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
                    <code className="w-32 shrink-0 font-mono text-xs text-accent">/{skill.id}</code>
                    <span className="flex-1 text-sm text-text-primary">{skill.description || skill.name}</span>
                    <div className="flex gap-1">
                      <button
                        className="rounded px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:bg-background"
                        onClick={() => {
                          dispatch(clearSkillError());
                          setEditMode({ type: 'edit', skill });
                        }}
                      >
                        Edit
                      </button>
                      {deleteConfirm === skill.id ? (
                        <>
                          <button
                            className="rounded px-2 py-0.5 text-xs text-error hover:bg-background"
                            onClick={() => handleDelete(skill.id)}
                          >
                            Confirm
                          </button>
                          <button
                            className="rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-background"
                            onClick={() => setDeleteConfirm(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="rounded px-2 py-0.5 text-xs text-text-secondary hover:text-error hover:bg-background"
                          onClick={() => setDeleteConfirm(skill.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {error && editMode.type === 'none' && (
        <p className="text-xs text-error">{error}</p>
      )}
    </div>
  );
}
