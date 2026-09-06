import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { SESSION_ACTIVITY_LIMIT, type SessionActivityResponse } from "../../../../packages/session-activity/src/contract.js";
import { mobileRequest } from "./mobile-api.js";
import { currentDraftScope } from "./session-drafts.js";
import { markSessionSeen, readSeenSessions, seenStorageKey, type SeenSessions } from "./session-seen.js";

export function useSessionActivity(enabled: boolean) {
  return useQuery({
    queryKey: ["session-activity"], enabled, retry: false, staleTime: 2_000,
    refetchInterval: 5_000, refetchIntervalInBackground: false,
    queryFn: async (): Promise<SessionActivityResponse> => {
      const response = await mobileRequest<SessionActivityResponse>("activity");
      if (!Array.isArray(response.sessions) || response.sessions.length > SESSION_ACTIVITY_LIMIT) throw new Error("Agent activity is unavailable.");
      return response;
    },
  });
}

export function useSeenSessions() {
  const scope = currentDraftScope();
  const read = useCallback(() => {
    try { return readSeenSessions(localStorage, scope); } catch { return {}; }
  }, [scope]);
  const [seen, setSeen] = useState<SeenSessions>(read);
  useEffect(() => {
    setSeen(read());
    const update = (event: StorageEvent) => { if (event.key === null || event.key === seenStorageKey(scope)) setSeen(read()); };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [scope, read]);
  const acknowledge = useCallback((sessionId: string, eventId: string) => {
    setSeen(previous => {
      if (previous[sessionId] === eventId) return previous;
      const next = markSessionSeen({ ...previous, ...read() }, sessionId, eventId);
      try { localStorage.setItem(seenStorageKey(scope), JSON.stringify(next)); } catch { /* In-memory review markers remain usable. */ }
      return next;
    });
  }, [scope, read]);
  return { seen, acknowledge };
}
