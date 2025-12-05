import { useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  loadProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  setCurrentProject,
} from '../store/slices/projectSlice';
import { CreateProjectParams, UpdateProjectParams } from '../types/project.types';

export function useProjects() {
  const dispatch = useAppDispatch();
  const {
    projects,
    currentProjectId,
    isLoading,
    isSaving,
    error,
  } = useAppSelector((state) => state.project);

  // Load all projects
  const loadAll = useCallback(() => {
    dispatch(loadProjects());
  }, [dispatch]);

  // Create a new project
  const create = useCallback(
    async (params: CreateProjectParams) => {
      const result = await dispatch(createProject(params));
      return result.payload;
    },
    [dispatch]
  );

  // Get a specific project
  const get = useCallback(
    async (projectId: string) => {
      const result = await dispatch(getProject(projectId));
      return result.payload;
    },
    [dispatch]
  );

  // Update project
  const update = useCallback(
    async (params: UpdateProjectParams) => {
      await dispatch(updateProject(params));
    },
    [dispatch]
  );

  // Delete project
  const remove = useCallback(
    async (projectId: string) => {
      await dispatch(deleteProject(projectId));
    },
    [dispatch]
  );

  // Set current project
  const setCurrent = useCallback(
    (projectId: string | null) => {
      dispatch(setCurrentProject(projectId));
    },
    [dispatch]
  );

  // Get current project
  const currentProject = projects.find((p) => p.id === currentProjectId) || null;

  return {
    projects,
    currentProjectId,
    currentProject,
    isLoading,
    isSaving,
    error,
    loadAll,
    create,
    get,
    update,
    remove,
    setCurrent,
  };
}
