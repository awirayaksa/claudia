import { useCallback, useEffect, useRef } from 'react';
import { api } from '../api/rtk-api';
import { useWebDispatch } from '../hooks';
import { followRun } from './run-stream';
import { runCleared, runEvent, runFollowed } from './run-slice';

/** One SSE follower per run, shared by every page that shows the chat. */
const following = new Map<string, () => void>();

/**
 * Follow runs of a chat: feed their events into the run slice, then refetch
 * the chat (and the list, for the new title) when a run ends.
 */
export function useRunFollower() {
  const dispatch = useWebDispatch();
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const follow = useCallback((chatId: string, runId: string, after = 0) => {
    if (following.has(runId)) return;
    const d = dispatchRef.current;
    d(runFollowed({ chatId, runId }));
    const stop = followRun(
      runId,
      after,
      (envelope) => d(runEvent({ chatId, envelope })),
      async () => {
        following.delete(runId);
        // Bring the stored chat up to date, then drop the live copy
        await d(api.endpoints.chat.initiate(chatId, { forceRefetch: true, subscribe: false }));
        d(api.util.invalidateTags(['Chats']));
        d(runCleared({ chatId, runId }));
      }
    );
    following.set(runId, stop);
  }, []);

  return { follow };
}

/** Stop every follower (sign-out). */
export function stopAllFollowers(): void {
  for (const stop of following.values()) stop();
  following.clear();
}

/** Resume runs the server reports as active for this chat (reload, second tab). */
export function useResumeActiveRuns(chatId: string | undefined, activeRuns: Array<{ runId: string }> | undefined) {
  const { follow } = useRunFollower();
  useEffect(() => {
    if (!chatId || !activeRuns) return;
    for (const r of activeRuns) follow(chatId, r.runId, 0);
  }, [chatId, activeRuns, follow]);
}
