// Conversation types for managing chat history

import { Message } from './message.types';

export interface Conversation {
  id: string;
  projectId: string | null; // null for default project
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messages: Message[];
  messageCount: number;
}

export interface ConversationMetadata {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
}

export interface ConversationState {
  conversations: ConversationMetadata[];
  currentConversationId: string | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
}

export interface CreateConversationParams {
  projectId?: string | null;
  title?: string;
  model: string;
}

export interface UpdateConversationParams {
  id: string;
  title?: string;
  model?: string;
}
