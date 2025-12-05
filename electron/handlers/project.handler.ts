import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface ProjectSettings {
  defaultModel?: string;
  systemPrompt?: string;
}

interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
  conversationCount?: number;
}

// Get the projects directory path
function getProjectsDir(): string {
  const userDataPath = app.getPath('userData');
  const projectsDir = path.join(userDataPath, 'projects');

  // Ensure directory exists
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  return projectsDir;
}

// Get project file path
function getProjectPath(projectId: string): string {
  const projectsDir = getProjectsDir();
  return path.join(projectsDir, `${projectId}.json`);
}

// Get conversations directory for counting
function getConversationsDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'conversations');
}

// Count conversations for a project
function countProjectConversations(projectId: string): number {
  const conversationsDir = getConversationsDir();
  const projectConversationsDir = path.join(conversationsDir, projectId);

  if (!fs.existsSync(projectConversationsDir)) {
    return 0;
  }

  const files = fs.readdirSync(projectConversationsDir);
  return files.filter((file) => file.endsWith('.json')).length;
}

// Create project
async function createProject(project: Project): Promise<Project> {
  const projectPath = getProjectPath(project.id);

  // Set timestamps
  project.createdAt = new Date().toISOString();
  project.updatedAt = new Date().toISOString();
  project.conversationCount = 0;

  // Write to file
  fs.writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf-8');

  return project;
}

// Update project
async function updateProject(projectId: string, updates: Partial<Project>): Promise<Project> {
  const projectPath = getProjectPath(projectId);

  if (!fs.existsSync(projectPath)) {
    throw new Error('Project not found');
  }

  // Load existing project
  const data = fs.readFileSync(projectPath, 'utf-8');
  const project: Project = JSON.parse(data);

  // Apply updates
  if (updates.name !== undefined) project.name = updates.name;
  if (updates.description !== undefined) project.description = updates.description;
  if (updates.settings !== undefined) {
    project.settings = { ...project.settings, ...updates.settings };
  }

  project.updatedAt = new Date().toISOString();

  // Save updated project
  fs.writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf-8');

  return project;
}

// List all projects
async function listProjects(): Promise<Project[]> {
  const projectsDir = getProjectsDir();
  const projects: Project[] = [];

  if (!fs.existsSync(projectsDir)) {
    return projects;
  }

  const files = fs.readdirSync(projectsDir);

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const filePath = path.join(projectsDir, file);

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const project: Project = JSON.parse(data);

      // Count conversations for this project
      project.conversationCount = countProjectConversations(project.id);

      projects.push(project);
    } catch (error) {
      console.error(`Failed to read project file: ${filePath}`, error);
    }
  }

  // Sort by updatedAt descending
  projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return projects;
}

// Get a single project
async function getProject(projectId: string): Promise<Project | null> {
  const projectPath = getProjectPath(projectId);

  if (!fs.existsSync(projectPath)) {
    return null;
  }

  const data = fs.readFileSync(projectPath, 'utf-8');
  const project: Project = JSON.parse(data);

  // Count conversations
  project.conversationCount = countProjectConversations(project.id);

  return project;
}

// Delete project
async function deleteProject(projectId: string): Promise<void> {
  const projectPath = getProjectPath(projectId);

  if (fs.existsSync(projectPath)) {
    fs.unlinkSync(projectPath);
  }

  // Note: We don't delete conversations, they become orphaned
  // User can manually clean up if needed
}

// Register IPC handlers
export function registerProjectHandlers(): void {
  // Create project
  ipcMain.handle('project:create', async (_event, project: Project) => {
    try {
      const created = await createProject(project);
      return { success: true, data: created };
    } catch (error) {
      console.error('Failed to create project:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create project',
      };
    }
  });

  // Update project
  ipcMain.handle('project:update', async (_event, projectId: string, updates: Partial<Project>) => {
    try {
      const updated = await updateProject(projectId, updates);
      return { success: true, data: updated };
    } catch (error) {
      console.error('Failed to update project:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update project',
      };
    }
  });

  // List projects
  ipcMain.handle('project:list', async () => {
    try {
      const projects = await listProjects();
      return { success: true, data: projects };
    } catch (error) {
      console.error('Failed to list projects:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list projects',
      };
    }
  });

  // Get project
  ipcMain.handle('project:get', async (_event, projectId: string) => {
    try {
      const project = await getProject(projectId);
      return { success: true, data: project };
    } catch (error) {
      console.error('Failed to get project:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get project',
      };
    }
  });

  // Delete project
  ipcMain.handle('project:delete', async (_event, projectId: string) => {
    try {
      await deleteProject(projectId);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete project:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete project',
      };
    }
  });
}
