import { z } from 'zod';

export const ScheduleInput = z.object({
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(20_000),
  modelId: z.string().min(1).max(500),
  /** Five fields: minute hour day-of-month month day-of-week, e.g. "0 8 * * 1-5". */
  cron: z.string().trim().min(9).max(100),
  /** IANA zone, e.g. "Europe/Oslo". */
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  /** "new": a new chat each time; "same": continue one chat. */
  chatMode: z.enum(['new', 'same']).default('new'),
  toolIds: z.array(z.string()).max(20).default([]),
  webSearch: z.boolean().default(false),
  enabled: z.boolean().default(true),
});
export type ScheduleInput = z.input<typeof ScheduleInput>;

export interface ScheduleView {
  id: string;
  name: string;
  prompt: string;
  modelId: string;
  cron: string;
  timezone: string;
  chatMode: 'new' | 'same';
  toolIds: string[];
  webSearch: boolean;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** "started", "completed", "stopped", "error" or "skipped". */
  lastStatus: string | null;
  lastError: string | null;
  /** The chat the last run wrote to. */
  lastChatId: string | null;
}

/** Common schedules for the editor. */
export const CRON_PRESETS: Array<{ id: string; cron: string }> = [
  { id: 'weekdays8', cron: '0 8 * * 1-5' },
  { id: 'daily8', cron: '0 8 * * *' },
  { id: 'mondays9', cron: '0 9 * * 1' },
  { id: 'hourly', cron: '0 * * * *' },
  { id: 'monthly1', cron: '0 9 1 * *' },
];

/** Schedules may not run more often than this. */
export const MIN_SCHEDULE_INTERVAL_MS = 15 * 60_000;
