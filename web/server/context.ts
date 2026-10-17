import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config';
import type { DbHandle, Database } from './db/client';
import type { Keyring } from './crypto/keys';
import type { SecretBox } from './crypto/secrets';
import type { AppSettings } from './modules/settings/app-settings';
import type { LoginGuard } from './auth/login-guard';
import type { ModelRegistry } from './llm/model-registry';
import type { RunHub } from './llm/run-hub';
import type { ChatOrchestrator } from './llm/chat-orchestrator';

/** Everything a route or service needs, built once at startup. */
export interface ServerContext {
  config: AppConfig;
  dbHandle: DbHandle;
  db: Database;
  keyring: Keyring;
  secrets: SecretBox;
  settings: AppSettings;
  loginGuard: LoginGuard;
  models: ModelRegistry;
  runs: RunHub;
  orchestrator: ChatOrchestrator;
  log: FastifyBaseLogger;
}
