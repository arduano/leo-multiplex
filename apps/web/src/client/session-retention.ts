import type { SessionRecord, SourceDiagnostic } from "@arduano/agent-multiplex-protocol";
import { SESSION_LIST_LIMIT } from "./session-catalog.js";

export interface RetainedSession {
  readonly session: SessionRecord;
  readonly stale: boolean;
}

/** Memory-only presentation cache; absence never creates catalog authority. */
export function retainSessionRows(
  previous: readonly RetainedSession[],
  current: readonly SessionRecord[],
  sources: readonly SourceDiagnostic[],
  fresh: boolean,
  mayRemoveAbsent = true,
): RetainedSession[] {
  const authoritative = new Set(sources.filter((source) => source.state === "selected")
    .flatMap((source) => source.manifest?.coveredControlNodeIds ?? []));
  const currentIds = new Set(current.map((session) => session.sessionId));
  const rows = current.map((session) => ({ session, stale: !fresh || !authoritative.has(session.metadataAuthority.controlNodeId) }));
  for (const row of previous) {
    if (currentIds.has(row.session.sessionId)) continue;
    // A fresh selected source can authoritatively remove an archived/deleted
    // row. Disconnected, synchronizing, or conflicting sources cannot.
    if (fresh && mayRemoveAbsent && authoritative.has(row.session.metadataAuthority.controlNodeId)) continue;
    rows.push({ session: row.session, stale: true });
  }
  // The paginated fleet refresh and its presentation cache share one bound.
  return rows.slice(0, SESSION_LIST_LIMIT);
}
