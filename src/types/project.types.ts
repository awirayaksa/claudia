// Project types for organizing conversations

export interface ProjectSettings {
  defaultModel?: string;
  systemPrompt?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
  conversationCount?: number;
}

export interface ProjectState {
  projects: Project[];
  currentProjectId: string | null; // null = default/no project
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
}

export interface CreateProjectParams {
  name: string;
  description?: string;
  settings?: ProjectSettings;
}

export interface UpdateProjectParams {
  id: string;
  name?: string;
  description?: string;
  settings?: ProjectSettings;
}
