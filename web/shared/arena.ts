/**
 * Blind comparisons ("Arena"): two models answer a turn without their names;
 * the user picks the better one (or a tie), and only then sees which was
 * which. Votes feed an Elo leaderboard for admins.
 */
import { z } from 'zod';

/** The model id users pick to start a blind comparison. */
export const ARENA_MODEL_ID = 'arena/blind';
/** What the two replies are called until the vote. */
export const ARENA_LABELS = ['arena:A', 'arena:B'] as const;

export const ArenaVoteInput = z.object({ winner: z.enum(['a', 'b', 'tie']) });
export type ArenaWinner = z.infer<typeof ArenaVoteInput>['winner'];

export interface ArenaVoteResult {
  winner: ArenaWinner;
  /** The real models, in A/B order. */
  models: [string, string];
}

export interface LeaderboardRow {
  modelId: string;
  /** Elo, starting at 1000 (K = 32, votes in time order). */
  rating: number;
  wins: number;
  losses: number;
  ties: number;
  games: number;
}

export interface LeaderboardResponse {
  rows: LeaderboardRow[];
  votes: number;
  /** Thumbs on replies, per model (all chats). */
  ratings: Array<{ modelId: string; up: number; down: number }>;
}

export const ELO_START = 1000;
export const ELO_K = 32;

/** Elo ratings from votes in time order. */
export function eloRatings(votes: Array<{ modelA: string; modelB: string; winner: ArenaWinner }>): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { modelId: id, rating: ELO_START, wins: 0, losses: 0, ties: 0, games: 0 }));
    return r;
  };
  for (const v of votes) {
    const a = row(v.modelA);
    const b = row(v.modelB);
    const expectedA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    const scoreA = v.winner === 'a' ? 1 : v.winner === 'b' ? 0 : 0.5;
    a.rating += ELO_K * (scoreA - expectedA);
    b.rating += ELO_K * (1 - scoreA - (1 - expectedA));
    a.games++;
    b.games++;
    if (v.winner === 'tie') {
      a.ties++;
      b.ties++;
    } else if (v.winner === 'a') {
      a.wins++;
      b.losses++;
    } else {
      b.wins++;
      a.losses++;
    }
  }
  return [...rows.values()].map((r) => ({ ...r, rating: Math.round(r.rating) })).sort((x, y) => y.rating - x.rating || y.games - x.games);
}
