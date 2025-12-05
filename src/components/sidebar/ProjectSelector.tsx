import React, { useState, useEffect } from 'react';
import { useProjects } from '../../hooks/useProjects';

interface ProjectSelectorProps {
  onManageProjects: () => void;
}

export function ProjectSelector({ onManageProjects }: ProjectSelectorProps) {
  const {
    projects,
    currentProjectId,
    isLoading,
    loadAll,
    setCurrent,
  } = useProjects();

  const [isOpen, setIsOpen] = useState(false);

  // Load projects on mount
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSelectProject = (projectId: string | null) => {
    setCurrent(projectId);
    setIsOpen(false);
  };

  const currentProject = projects.find((p) => p.id === currentProjectId);
  const displayName = currentProject ? currentProject.name : 'All Conversations';

  return (
    <div className="relative">
      {/* Selector button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary hover:bg-surface transition-colors"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <svg
            className="h-4 w-4 flex-shrink-0 text-text-secondary"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          <span className="truncate font-medium">{displayName}</span>
        </div>
        <svg
          className={`h-4 w-4 flex-shrink-0 text-text-secondary transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Menu */}
          <div className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
            {/* All Conversations option */}
            <button
              onClick={() => handleSelectProject(null)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                currentProjectId === null
                  ? 'bg-accent text-white'
                  : 'text-text-primary hover:bg-background'
              }`}
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
                  d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                />
              </svg>
              <span>All Conversations</span>
            </button>

            {/* Divider */}
            {projects.length > 0 && (
              <div className="border-t border-border my-1" />
            )}

            {/* Project options */}
            {isLoading && projects.length === 0 ? (
              <div className="px-3 py-2 text-sm text-text-secondary">
                Loading projects...
              </div>
            ) : projects.length === 0 ? (
              <div className="px-3 py-2 text-sm text-text-secondary">
                No projects yet
              </div>
            ) : (
              projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => handleSelectProject(project.id)}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${
                    currentProjectId === project.id
                      ? 'bg-accent text-white'
                      : 'text-text-primary hover:bg-background'
                  }`}
                >
                  <svg
                    className="h-4 w-4 mt-0.5 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                    />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{project.name}</div>
                    {project.description && (
                      <div className={`text-xs truncate ${
                        currentProjectId === project.id
                          ? 'text-white text-opacity-80'
                          : 'text-text-secondary'
                      }`}>
                        {project.description}
                      </div>
                    )}
                    <div className={`text-xs ${
                      currentProjectId === project.id
                        ? 'text-white text-opacity-80'
                        : 'text-text-secondary'
                    }`}>
                      {project.conversationCount || 0} conversations
                    </div>
                  </div>
                </button>
              ))
            )}

            {/* Divider */}
            <div className="border-t border-border my-1" />

            {/* Manage Projects button */}
            <button
              onClick={() => {
                setIsOpen(false);
                onManageProjects();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-accent hover:bg-background transition-colors"
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
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              <span>Manage Projects</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
