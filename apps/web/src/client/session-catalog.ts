import type { SessionRecord, SessionSearchInput, SessionSearchPage } from "@arduano/agent-multiplex-protocol";

export const SESSION_LIST_LIMIT = 500;

/** One bounded refresh across all selected sources. A short page is not EOF. */
export async function readSessionCatalog(
  readPage: (input: SessionSearchInput) => Promise<SessionSearchPage>,
  signal: AbortSignal,
): Promise<{ sessions: SessionRecord[]; complete: boolean }> {
  const sessions = new Map<string, SessionRecord>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  // Bound empty/duplicate pages too; never publish a partial refresh as complete.
  for (let pageNumber = 0; pageNumber < SESSION_LIST_LIMIT; pageNumber++) {
    signal.throwIfAborted();
    const page = await readPage({ states: ["running", "stopped"], metadata: [], limit: SESSION_LIST_LIMIT,
      ...(cursor === undefined ? {} : { cursor }) });
    signal.throwIfAborted();
    for (const session of page.sessions) {
      if (!sessions.has(session.sessionId) && sessions.size === SESSION_LIST_LIMIT) {
        return { sessions: [...sessions.values()], complete: false };
      }
      sessions.set(session.sessionId, session);
    }
    if (page.nextCursor === null) return { sessions: [...sessions.values()], complete: true };
    if (sessions.size === SESSION_LIST_LIMIT) return { sessions: [...sessions.values()], complete: false };
    if (cursors.has(page.nextCursor)) throw new Error("Agent list pagination did not advance. Retry the workspace refresh.");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return { sessions: [...sessions.values()], complete: false };
}
