import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messages: any[];
  messageCount: number;
  starred?: boolean;
}

interface ConversationMetadata {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  starred?: boolean;
}

// Get the conversations directory path
function getConversationsDir(): string {
  const userDataPath = app.getPath('userData');
  const conversationsDir = path.join(userDataPath, 'conversations');

  // Ensure directory exists
  if (!fs.existsSync(conversationsDir)) {
    fs.mkdirSync(conversationsDir, { recursive: true });
  }

  return conversationsDir;
}

// Get conversation file path
function getConversationPath(conversationId: string, projectId: string | null): string {
  const conversationsDir = getConversationsDir();

  if (projectId) {
    const projectDir = path.join(conversationsDir, projectId);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    return path.join(projectDir, `${conversationId}.json`);
  }

  return path.join(conversationsDir, `${conversationId}.json`);
}

/** Fields owned by `conversation:updateMeta`; a full save never overwrites them. */
export type ConversationMetaPatch = Partial<Pick<Conversation, 'title' | 'model' | 'starred'>>;

function toMetadata(conversation: Conversation): ConversationMetadata {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    model: conversation.model,
    messageCount: conversation.messageCount || conversation.messages?.length || 0,
    starred: conversation.starred || false,
  };
}

function readConversationFile(conversationPath: string): Conversation | null {
  if (!fs.existsSync(conversationPath)) return null;
  return JSON.parse(fs.readFileSync(conversationPath, 'utf-8'));
}

// Save conversation (messages). Uses only synchronous fs calls, so no other
// IPC handler can interleave between the read and the write.
function saveConversation(conversation: Conversation): ConversationMetadata {
  const conversationPath = getConversationPath(conversation.id, conversation.projectId);
  const existing = readConversationFile(conversationPath);

  // Title, model and starred change only through updateMeta. The renderer's
  // autosave may still carry values from before a rename or an AI title, so
  // the copy on disk wins for an existing conversation.
  const merged: Conversation = existing
    ? { ...conversation, title: existing.title, model: existing.model, starred: existing.starred }
    : { ...conversation };
  merged.updatedAt = new Date().toISOString();

  fs.writeFileSync(conversationPath, JSON.stringify(merged, null, 2), 'utf-8');
  return toMetadata(merged);
}

// Patch title/model/starred in one synchronous read-modify-write.
function updateConversationMeta(
  conversationId: string,
  projectId: string | null,
  patch: ConversationMetaPatch
): ConversationMetadata {
  const conversationPath = getConversationPath(conversationId, projectId);
  const existing = readConversationFile(conversationPath);
  if (!existing) {
    throw new Error('Conversation not found');
  }

  const updated: Conversation = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) updated.title = patch.title;
  if (patch.model !== undefined) updated.model = patch.model;
  if (patch.starred !== undefined) updated.starred = patch.starred;

  fs.writeFileSync(conversationPath, JSON.stringify(updated, null, 2), 'utf-8');
  return toMetadata(updated);
}

// Load conversation
async function loadConversation(conversationId: string, projectId: string | null): Promise<Conversation | null> {
  const conversationPath = getConversationPath(conversationId, projectId);

  if (!fs.existsSync(conversationPath)) {
    return null;
  }

  const data = fs.readFileSync(conversationPath, 'utf-8');
  return JSON.parse(data);
}

// List all conversations
async function listConversations(projectId?: string | null): Promise<ConversationMetadata[]> {
  const conversationsDir = getConversationsDir();
  const conversations: ConversationMetadata[] = [];

  // Function to scan directory for conversation files
  const scanDirectory = (dirPath: string, currentProjectId: string | null) => {
    if (!fs.existsSync(dirPath)) {
      return;
    }

    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory() && projectId === undefined) {
        // Recursively scan project directories
        scanDirectory(filePath, file);
      } else if (stat.isFile() && file.endsWith('.json')) {
        try {
          const data = fs.readFileSync(filePath, 'utf-8');
          const conversation: Conversation = JSON.parse(data);

          conversations.push(toMetadata(conversation));
        } catch (error) {
          console.error(`Failed to read conversation file: ${filePath}`, error);
        }
      }
    }
  };

  if (projectId !== undefined) {
    // List conversations for specific project
    if (projectId === null) {
      // Root level conversations
      scanDirectory(conversationsDir, null);
    } else {
      // Project-specific conversations
      const projectDir = path.join(conversationsDir, projectId);
      scanDirectory(projectDir, projectId);
    }
  } else {
    // List all conversations
    scanDirectory(conversationsDir, null);
  }

  // Sort starred first, then by updatedAt descending
  conversations.sort((a, b) => {
    if (a.starred && !b.starred) return -1;
    if (!a.starred && b.starred) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return conversations;
}

// Delete conversation
async function deleteConversation(conversationId: string, projectId: string | null): Promise<void> {
  const conversationPath = getConversationPath(conversationId, projectId);

  if (fs.existsSync(conversationPath)) {
    fs.unlinkSync(conversationPath);
  }
}

// Delete multiple conversations
async function deleteMultipleConversations(
  conversations: Array<{ id: string; projectId: string | null }>
): Promise<void> {
  for (const conv of conversations) {
    await deleteConversation(conv.id, conv.projectId);
  }
}

// Delete all conversations for a project
async function deleteAllConversations(projectId: string | null): Promise<void> {
  const conversations = await listConversations(projectId);
  for (const conv of conversations) {
    await deleteConversation(conv.id, conv.projectId);
  }
}

// Register IPC handlers
export function registerConversationHandlers(): void {
  // Save conversation
  ipcMain.handle('conversation:save', async (_event, conversation: Conversation) => {
    try {
      const metadata = saveConversation(conversation);
      return { success: true, data: metadata };
    } catch (error) {
      console.error('Failed to save conversation:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save conversation',
      };
    }
  });

  // Update title / model / starred without touching messages
  ipcMain.handle(
    'conversation:updateMeta',
    async (_event, conversationId: string, projectId: string | null, patch: ConversationMetaPatch) => {
      try {
        const metadata = updateConversationMeta(conversationId, projectId, patch);
        return { success: true, data: metadata };
      } catch (error) {
        console.error('Failed to update conversation:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update conversation',
        };
      }
    }
  );

  // Load conversation
  ipcMain.handle('conversation:load', async (_event, conversationId: string, projectId: string | null) => {
    try {
      const conversation = await loadConversation(conversationId, projectId);
      return { success: true, data: conversation };
    } catch (error) {
      console.error('Failed to load conversation:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load conversation',
      };
    }
  });

  // List conversations
  ipcMain.handle('conversation:list', async (_event, projectId?: string | null) => {
    try {
      const conversations = await listConversations(projectId);
      return { success: true, data: conversations };
    } catch (error) {
      console.error('Failed to list conversations:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list conversations',
      };
    }
  });

  // Delete conversation
  ipcMain.handle('conversation:delete', async (_event, conversationId: string, projectId: string | null) => {
    try {
      await deleteConversation(conversationId, projectId);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete conversation:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete conversation',
      };
    }
  });

  // Delete multiple conversations
  ipcMain.handle('conversation:deleteMultiple', async (_event, conversations: Array<{ id: string; projectId: string | null }>) => {
    try {
      await deleteMultipleConversations(conversations);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete multiple conversations:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete conversations',
      };
    }
  });

  // Delete all conversations
  ipcMain.handle('conversation:deleteAll', async (_event, projectId: string | null) => {
    try {
      await deleteAllConversations(projectId);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete all conversations:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete all conversations',
      };
    }
  });
}
