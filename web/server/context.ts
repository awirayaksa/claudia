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
import type { Storage } from './storage/local';
import type { ExtractPool } from './extract/pool';
import type { FileService } from './modules/files/service';
import type { SkillService } from './modules/skills/service';
import type { McpPools } from './mcp/mcp-pool';
import type { LdapService } from './auth/ldap';
import type { ShareService } from './modules/shares/service';
import type { AccessService } from './auth/access';
import type { UsageService } from './modules/usage/service';
import type { RagConfig } from './rag/config';
import type { KnowledgeService } from './rag/knowledge';
import type { JobQueue } from './jobs/queue';
import type { EventHub } from './ws/gateway';
import type { MediaConfig } from './media/config';
import type { Cluster } from './cluster/cluster';
import type { AuditLog } from './admin/audit';
import type { Webhooks } from './admin/webhooks';
import type { OidcService } from './auth/providers/oidc';
import type { CloudFiles } from './cloud/cloud-files';
import type { ScheduleRunner } from './modules/schedules/service';
import type { MemoryStore } from './modules/memories/store';
import type { MemoryLearner } from './modules/memories/learn';
import type { McpOAuth } from './mcp/oauth';

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
  storage: Storage;
  extract: ExtractPool;
  files: FileService;
  skills: SkillService;
  mcp: McpPools;
  /** OAuth sign-ins to remote MCP servers. */
  mcpOAuth: McpOAuth;
  ldap: LdapService;
  shares: ShareService;
  access: AccessService;
  usage: UsageService;
  rag: RagConfig;
  knowledge: KnowledgeService;
  /** What chats know about each user, and learning it from chats. */
  memories: MemoryStore;
  memoryLearner: MemoryLearner;
  jobs: JobQueue;
  events: EventHub;
  media: MediaConfig;
  /** Other instances: pub/sub, shared state and change signals. */
  cluster: Cluster;
  audit: AuditLog;
  webhooks: Webhooks;
  /** OpenID Connect sign-in providers. */
  sso: OidcService;
  /** Google Drive / OneDrive. */
  cloud: CloudFiles;
  /** Scheduled prompts (runs due ones every 30 s). */
  schedules: ScheduleRunner;
  log: FastifyBaseLogger;
}
