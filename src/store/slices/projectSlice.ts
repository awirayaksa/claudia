import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import {
  Project,
  ProjectState,
  CreateProjectParams,
  UpdateProjectParams,
} from '../../types/project.types';
import { v4 as uuidv4 } from 'uuid';

const initialState: ProjectState = {
  projects: [],
  currentProjectId: null, // null = default/no project
  isLoading: false,
  isSaving: false,
  error: null,
};

// Create a new project
export const createProject = createAsyncThunk(
  'project/create',
  async (params: CreateProjectParams, { rejectWithValue }) => {
    try {
      const project: Project = {
        id: uuidv4(),
        name: params.name,
        description: params.description || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        settings: params.settings || {},
        conversationCount: 0,
      };

      const result = await window.electron.project.create(project);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to create project');
      }

      return result.data as Project;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to create project'
      );
    }
  }
);

// Load all projects
export const loadProjects = createAsyncThunk(
  'project/loadAll',
  async (_, { rejectWithValue }) => {
    try {
      const result = await window.electron.project.list();

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to load projects');
      }

      return result.data as Project[];
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to load projects'
      );
    }
  }
);

// Get a specific project
export const getProject = createAsyncThunk(
  'project/get',
  async (projectId: string, { rejectWithValue }) => {
    try {
      const result = await window.electron.project.get(projectId);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to get project');
      }

      return result.data as Project;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to get project'
      );
    }
  }
);

// Update project
export const updateProject = createAsyncThunk(
  'project/update',
  async (params: UpdateProjectParams, { rejectWithValue }) => {
    try {
      const updates: any = {};
      if (params.name !== undefined) updates.name = params.name;
      if (params.description !== undefined) updates.description = params.description;
      if (params.settings !== undefined) updates.settings = params.settings;

      const result = await window.electron.project.update(params.id, updates);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to update project');
      }

      return result.data as Project;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to update project'
      );
    }
  }
);

// Delete project
export const deleteProject = createAsyncThunk(
  'project/delete',
  async (projectId: string, { rejectWithValue }) => {
    try {
      const result = await window.electron.project.delete(projectId);

      if (!result.success) {
        return rejectWithValue(result.error || 'Failed to delete project');
      }

      return projectId;
    } catch (error) {
      return rejectWithValue(
        error instanceof Error ? error.message : 'Failed to delete project'
      );
    }
  }
);

const projectSlice = createSlice({
  name: 'project',
  initialState,
  reducers: {
    setCurrentProject: (state, action: PayloadAction<string | null>) => {
      state.currentProjectId = action.payload;
    },
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Create project
      .addCase(createProject.pending, (state) => {
        state.isSaving = true;
        state.error = null;
      })
      .addCase(createProject.fulfilled, (state, action) => {
        state.isSaving = false;
        state.projects.unshift(action.payload);
        state.currentProjectId = action.payload.id;
      })
      .addCase(createProject.rejected, (state, action) => {
        state.isSaving = false;
        state.error = action.payload as string;
      })

      // Load projects
      .addCase(loadProjects.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadProjects.fulfilled, (state, action) => {
        state.isLoading = false;
        state.projects = action.payload;
      })
      .addCase(loadProjects.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // Get project
      .addCase(getProject.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(getProject.fulfilled, (state, action) => {
        state.isLoading = false;
        // Update the project in the list if it exists
        const index = state.projects.findIndex((p) => p.id === action.payload.id);
        if (index !== -1) {
          state.projects[index] = action.payload;
        }
      })
      .addCase(getProject.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      })

      // Update project
      .addCase(updateProject.pending, (state) => {
        state.isSaving = true;
      })
      .addCase(updateProject.fulfilled, (state, action) => {
        state.isSaving = false;
        const index = state.projects.findIndex((p) => p.id === action.payload.id);
        if (index !== -1) {
          state.projects[index] = action.payload;
        }
      })
      .addCase(updateProject.rejected, (state, action) => {
        state.isSaving = false;
        state.error = action.payload as string;
      })

      // Delete project
      .addCase(deleteProject.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(deleteProject.fulfilled, (state, action) => {
        state.isLoading = false;
        state.projects = state.projects.filter((p) => p.id !== action.payload);
        if (state.currentProjectId === action.payload) {
          state.currentProjectId = null;
        }
      })
      .addCase(deleteProject.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
      });
  },
});

export const { setCurrentProject, clearError } = projectSlice.actions;

export default projectSlice.reducer;
