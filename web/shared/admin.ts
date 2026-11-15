/**
 * Admin operations: audit log, webhooks, banners and usage analytics.
 */
import { z } from 'zod';

// ─── Audit log ───────────────────────────────────────────────────────────────

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.signup',
  'api_key.created',
  'api_key.revoked',
  'mfa.enabled',
  'mfa.disabled',
  /** A change made by the identity provider over SCIM. */
  'scim.request',
  /** Any change made through /api/admin. */
  'admin.request',
  /** An admin opened one recorded conversation turn. */
  'conversations.viewed',
  /** An admin downloaded recorded conversations as CSV. */
  'conversations.exported',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  route: string | null;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  status: number | null;
}

export const AuditQuery = z.object({
  action: z.string().max(100).optional(),
  /** Matches the actor's email (contains, case-insensitive). */
  actor: z.string().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** Entries older than this id (the previous page's last). */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AuditQuery = z.input<typeof AuditQuery>;

export interface AuditPage {
  entries: AuditEntry[];
  /** Pass as `before` for the next page; null at the end. */
  next: string | null;
}

// ─── Conversation log ────────────────────────────────────────────────────────

/**
 * Where a recorded turn came from: a chat, the OpenAI-compatible API
 * (/api/v1) or an @model mention in a channel.
 */
export const CONVERSATION_SOURCES = ['chat', 'api', 'channel'] as const;
export type ConversationSource = (typeof CONVERSATION_SOURCES)[number];

/** What gets recorded (setting "audit.conversations"); off by default. */
export const ConversationLogSetting = z.object({
  enabled: z.boolean(),
  /** Turns older than this are removed daily. */
  retentionDays: z.number().int().min(1).max(3650),
  chats: z.boolean(),
  api: z.boolean(),
  channels: z.boolean(),
});
export type ConversationLogSetting = z.infer<typeof ConversationLogSetting>;

/** A recorded turn in a list: the text is cut to a preview. */
export interface ConversationTurnSummary {
  id: string;
  createdAt: string;
  source: ConversationSource;
  userId: string | null;
  userEmail: string | null;
  modelId: string;
  chatId: string | null;
  chatTitle: string | null;
  /** The first characters of what the user sent and of the reply. */
  promptPreview: string;
  replyPreview: string;
  status: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** One recorded turn in full. */
export interface ConversationTurn extends ConversationTurnSummary {
  prompt: string;
  reply: string;
  error: string | null;
  messageId: string | null;
  /** Attachments, tool calls and other context, never file contents. */
  details: {
    attachments?: Array<{ name: string; mime?: string }>;
    toolCalls?: Array<{ name: string; args: string }>;
    continued?: boolean;
    [key: string]: unknown;
  };
  ip: string | null;
}

export const ConversationQuery = z.object({
  /** Matches the user's email (contains, case-insensitive). */
  user: z.string().max(200).optional(),
  source: z.enum(CONVERSATION_SOURCES).optional(),
  /** Text the prompt or the reply contains (case-insensitive). */
  q: z.string().max(500).optional(),
  chatId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ConversationQuery = z.input<typeof ConversationQuery>;

export interface ConversationPage {
  turns: ConversationTurnSummary[];
  next: string | null;
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
  'user.created',
  'user.updated',
  'run.completed',
  'knowledge.file_processed',
  'knowledge.file_failed',
  'audit.recorded',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'webhook.test';

/** Headers of every delivery. */
export const WEBHOOK_HEADERS = {
  event: 'x-claudia-event',
  delivery: 'x-claudia-delivery',
  timestamp: 'x-claudia-timestamp',
  /** "v1=<hex HMAC-SHA256 of `${timestamp}.${body}`>". */
  signature: 'x-claudia-signature',
} as const;

/** The JSON body of a delivery. */
export interface WebhookPayload<T = Record<string, unknown>> {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  data: T;
}

export const WebhookInput = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.url({ protocol: /^https?$/ }).max(2000),
  /** ["*"] for every event. */
  events: z.array(z.enum([...WEBHOOK_EVENTS, '*'])).min(1),
  enabled: z.boolean().default(true),
});
export type WebhookInput = z.input<typeof WebhookInput>;

export interface WebhookView {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

/** Creating a webhook or rotating its secret: the only time the secret is shown. */
export interface WebhookWithSecret {
  webhook: WebhookView;
  secret: string;
}

export interface WebhookTestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
}

// ─── Banners ─────────────────────────────────────────────────────────────────

export const Banner = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(['info', 'success', 'warning', 'error']),
  /** Plain text; links are made clickable. */
  content: z.string().trim().min(1).max(2000),
  dismissible: z.boolean(),
  /** Shown only in this window (ISO times); either may be open. */
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type Banner = z.infer<typeof Banner>;

/** The banners to show at `now`. */
export function activeBanners(banners: Banner[], now = new Date()): Banner[] {
  const t = now.getTime();
  return banners.filter((b) => (!b.startsAt || Date.parse(b.startsAt) <= t) && (!b.endsAt || Date.parse(b.endsAt) > t));
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export const AnalyticsQuery = z.object({
  /** Whole UTC days ending today. */
  days: z.coerce.number().int().min(1).max(366).default(30),
});

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  requests: number;
}

export interface AnalyticsResponse {
  from: string;
  to: string;
  totals: UsageTotals & { activeUsers: number; chats: number; messages: number };
  /** Every day of the range, oldest first, zeros included. */
  byDay: Array<UsageTotals & { day: string; activeUsers: number }>;
  byModel: Array<UsageTotals & { modelId: string }>;
  /** The 25 heaviest users by tokens. */
  byUser: Array<UsageTotals & { userId: string; email: string; name: string }>;
  /** Chat replies vs. titles and other background tasks. */
  byKind: Array<UsageTotals & { kind: string }>;
}
