import React, { useState, useEffect } from 'react';
import { Modal } from '../common/Modal';
import { Input } from '../common/Input';
import { Button } from '../common/Button';
import { useProjects } from '../../hooks/useProjects';
import { Project } from '../../types/project.types';
import { format } from 'date-fns';

interface ProjectManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ProjectManager({ isOpen, onClose }: ProjectManagerProps) {
  const {
    projects,
    isLoading,
    isSaving,
    create,
    update,
    remove,
    loadAll,
  } = useProjects();

  const [isCreating, setIsCreating] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
  });
  const [errors, setErrors] = useState<{ name?: string }>({});

  // Load projects when opening
  useEffect(() => {
    if (isOpen) {
      loadAll();
    }
  }, [isOpen, loadAll]);

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

    if (!formData.name.trim()) {
      newErrors.name = 'Project name is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleCreate = async () => {
    if (!validateForm()) return;

    try {
      await create({
        name: formData.name.trim(),
        description: formData.description.trim(),
      });

      setFormData({ name: '', description: '' });
      setIsCreating(false);
      loadAll();
    } catch (error) {
      console.error('Failed to create project:', error);
    }
  };

  const handleUpdate = async () => {
    if (!editingProject || !validateForm()) return;

    try {
      await update({
        id: editingProject.id,
        name: formData.name.trim(),
        description: formData.description.trim(),
      });

      setFormData({ name: '', description: '' });
      setEditingProject(null);
      loadAll();
    } catch (error) {
      console.error('Failed to update project:', error);
    }
  };

  const handleDelete = async (project: Project) => {
    const confirmMessage = project.conversationCount && project.conversationCount > 0
      ? `Delete "${project.name}"? This project has ${project.conversationCount} conversation(s). The conversations will not be deleted.`
      : `Delete "${project.name}"?`;

    if (window.confirm(confirmMessage)) {
      try {
        await remove(project.id);
        loadAll();
      } catch (error) {
        console.error('Failed to delete project:', error);
      }
    }
  };

  const startEdit = (project: Project) => {
    setEditingProject(project);
    setFormData({
      name: project.name,
      description: project.description,
    });
    setIsCreating(false);
  };

  const cancelEdit = () => {
    setEditingProject(null);
    setIsCreating(false);
    setFormData({ name: '', description: '' });
    setErrors({});
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Manage Projects">
      <div className="flex flex-col h-[500px]">
        {/* Create/Edit Form */}
        {(isCreating || editingProject) && (
          <div className="border-b border-border pb-4 mb-4">
            <h3 className="text-sm font-semibold text-text-primary mb-3">
              {editingProject ? 'Edit Project' : 'New Project'}
            </h3>
            <div className="space-y-3">
              <Input
                label="Project Name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                error={errors.name}
                placeholder="My Project"
              />
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">
                  Description (Optional)
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Project description..."
                  rows={3}
                  className="w-full resize-none rounded border border-border bg-background px-3 py-2 text-sm text-text-primary placeholder-text-secondary focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={editingProject ? handleUpdate : handleCreate}
                  disabled={isSaving}
                  size="sm"
                >
                  {isSaving ? 'Saving...' : editingProject ? 'Update' : 'Create'}
                </Button>
                <Button
                  onClick={cancelEdit}
                  variant="secondary"
                  size="sm"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* New Project Button */}
        {!isCreating && !editingProject && (
          <div className="mb-4">
            <Button
              onClick={() => setIsCreating(true)}
              className="w-full"
              size="sm"
            >
              <svg
                className="h-4 w-4 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              New Project
            </Button>
          </div>
        )}

        {/* Projects List */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && projects.length === 0 ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-text-secondary">Loading projects...</p>
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-center">
              <svg
                className="mx-auto mb-2 h-12 w-12 text-text-secondary opacity-50"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
              <p className="text-sm text-text-secondary">No projects yet</p>
              <p className="mt-1 text-xs text-text-secondary">
                Create a project to organize your conversations
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="rounded-lg border border-border bg-surface p-3 hover:bg-surface-hover transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-text-primary truncate">
                        {project.name}
                      </h4>
                      {project.description && (
                        <p className="text-sm text-text-secondary mt-1 line-clamp-2">
                          {project.description}
                        </p>
                      )}
                      <div className="flex items-center gap-4 mt-2 text-xs text-text-secondary">
                        <span>
                          {project.conversationCount || 0} conversations
                        </span>
                        <span>
                          Updated {format(new Date(project.updatedAt), 'MMM d, yyyy')}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => startEdit(project)}
                        className="p-1.5 rounded text-text-secondary hover:bg-background hover:text-accent transition-colors"
                        title="Edit"
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDelete(project)}
                        className="p-1.5 rounded text-text-secondary hover:bg-background hover:text-error transition-colors"
                        title="Delete"
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
