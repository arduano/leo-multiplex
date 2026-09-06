/** Small, per-browser review markers. No native payload or conversation text is stored. */
export const SEEN_SESSION_LIMIT = 500;
export type SeenSessions = Readonly<Record<string, string>>;
export function readSeenSessions(storage: Pick<Storage, "getItem">, scope: string): SeenSessions {
  if (!scope) return {};
  try {
    const text = storage.getItem(seenStorageKey(scope));
    if (!text || text.length > 100_000) return {};
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([sessionId, eventId]) =>
      /^[a-f0-9-]{36}$/i.test(sessionId) && typeof eventId === "string" && eventId.length > 0 && eventId.length <= 128).slice(-SEEN_SESSION_LIMIT));
  } catch { return {}; }
}
export function markSessionSeen(previous: SeenSessions, sessionId: string, eventId: string): SeenSessions {
  if (previous[sessionId] === eventId) return previous;
  return Object.fromEntries([...Object.entries(previous).filter(([key]) => key !== sessionId), [sessionId, eventId]].slice(-SEEN_SESSION_LIMIT));
}
export function seenStorageKey(scope: string): string { return `leo.session-seen.${scope}`; }
