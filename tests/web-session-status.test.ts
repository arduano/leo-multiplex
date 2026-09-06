import { describe, expect, it } from "vitest";
import type { RuntimeNodeDescriptor, SessionRecord } from "@arduano/agent-multiplex-protocol";
import type { SessionActivity } from "../packages/session-activity/src/contract.js";
import { activityTime, agentStatus, relativeActivityTime, statusMatchesFilter, statusRank } from "../apps/web/src/client/session-status.js";
import { markSessionSeen, readSeenSessions, SEEN_SESSION_LIMIT, seenStorageKey } from "../apps/web/src/client/session-seen.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = { sessionId: id(1), runtimeNodeId: id(2), adapterScopeId: "scope", vendorSessionId: "native", bindingRevision: 1,
  runtimeEpoch: id(3), harness: "codex", availability: "active", runtimeStatus: "idle", createdAt: "2026-09-01T00:00:00Z",
  lastActivityAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T01:00:00Z" } as SessionRecord;
const completion: SessionActivity = { sessionId: session.sessionId, runtimeNodeId: session.runtimeNodeId, adapterScopeId: session.adapterScopeId,
  vendorSessionId: session.vendorSessionId, bindingRevision: session.bindingRevision, runtimeEpoch: session.runtimeEpoch, harness: session.harness,
  eventId: "completed-a", kind: "completion", occurredAt: "2026-09-06T00:30:00Z" };
const runtime = { presence: "online", reachability: "reachable" } as RuntimeNodeDescriptor;

describe("glanceable session status", () => {
  it("distinguishes idle from successful completion and interruption", () => {
    expect(agentStatus(session, false).kind).toBe("ready");
    expect(agentStatus(session, false, runtime, completion).kind).toBe("finished");
    expect(agentStatus(session, false, runtime, { ...completion, kind: "interrupted" }).kind).toBe("interrupted");
  });
  it.each(["sessionId", "runtimeNodeId", "adapterScopeId", "vendorSessionId", "bindingRevision", "runtimeEpoch", "harness"] as const)("rejects an observation with a different %s", key => {
    const mismatch = { ...completion, [key]: key === "bindingRevision" ? 2 : "another" } as SessionActivity;
    expect(agentStatus(session, false, runtime, mismatch).kind).toBe("ready");
  });
  it("never labels an offline/stopped agent as working or finished", () => {
    const working = { ...session, runtimeStatus: "running" } as SessionRecord;
    for (const value of [session, working]) {
      for (const observed of [completion, { ...completion, kind: "working" } as SessionActivity]) {
        expect(agentStatus(value, true, runtime, observed).kind).toBe("offline");
        expect(agentStatus(value, false, { ...runtime, reachability: "unreachable" }, observed).kind).toBe("offline");
        expect(agentStatus({ ...value, availability: "unavailable" }, false, runtime, observed).kind).toBe("offline");
        expect(agentStatus({ ...value, availability: "resumable" }, false, runtime, observed).kind).toBe("stopped");
        expect(agentStatus({ ...value, runtimeStatus: "stopped" }, false, runtime, observed).kind).toBe("stopped");
      }
    }
  });
  it("surfaces an accepted failure despite stale running catalog state, then clears it on accepted work", () => {
    const running = { ...session, runtimeStatus: "running" } as SessionRecord;
    const failure = { ...completion, kind: "error", label: "Model at capacity" } as SessionActivity;
    expect(agentStatus(running, false, runtime, failure)).toMatchObject({ kind: "error", label: "Model at capacity" });
    const retry = { ...completion, kind: "working", label: "Retrying" } as SessionActivity;
    expect(agentStatus({ ...session, runtimeStatus: "error" }, false, runtime, retry)).toMatchObject({ kind: "working", label: "Retrying" });
    expect(agentStatus(running, false, runtime, completion).kind).toBe("working");
    expect(agentStatus({ ...session, runtimeStatus: "waitingForInput" }, false, runtime, retry).kind).toBe("input");
  });
  it("groups attention, working and finished separately while watched remains independent", () => {
    const error = agentStatus(session, false, runtime, { ...completion, kind: "error" });
    const finished = agentStatus(session, false, runtime, completion);
    const offline = agentStatus(session, true, runtime, completion);
    expect(statusMatchesFilter(error, "needsInput", false)).toBe(true);
    expect(statusMatchesFilter(finished, "finished", false)).toBe(true);
    for (const filter of ["needsInput", "working", "finished"] as const) expect(statusMatchesFilter(offline, filter, true)).toBe(false);
    expect(statusMatchesFilter(offline, "watched", true)).toBe(true);
    expect(statusMatchesFilter(error, "watched", false)).toBe(false);
    expect(statusRank(error, false)).toBeLessThan(statusRank(finished, true));
    expect(statusRank(finished, true)).toBeLessThan(statusRank(finished, false));
  });
  it("sorts by observed or native activity, without promoting metadata edits", () => {
    expect(activityTime(session, agentStatus(session, false))).toBe(session.lastActivityAt);
    expect(activityTime({ ...session, updatedAt: "2030-01-01T00:00:00Z" }, agentStatus(session, false))).toBe(session.lastActivityAt);
    expect(activityTime(session, agentStatus(session, false, runtime, completion))).toBe(completion.occurredAt);
    const now = Date.parse("2026-09-06T01:00:00Z");
    expect(relativeActivityTime("2026-09-06T00:30:00Z", now)).toBe("30m");
    expect(relativeActivityTime("2026-09-06T02:00:00Z", now)).toBe("now");
    expect(relativeActivityTime("invalid", now)).toBe("");
  });
});

describe("per-device review markers", () => {
  it("remembers an opened result, with a new event identity remaining unseen", () => {
    const seen = markSessionSeen({}, id(1), "done-a");
    expect(markSessionSeen(seen, id(1), "done-a")).toBe(seen);
    expect(seen[id(1)]).not.toBe("done-b");
    const storage = { getItem: (key: string) => key === seenStorageKey("owner-a") ? JSON.stringify(seen) : null };
    expect(readSeenSessions(storage, "owner-a")).toEqual(seen);
    expect(readSeenSessions(storage, "owner-b")).toEqual({});
  });
  it("bounds markers and retains the most recently reviewed sessions", () => {
    let seen = {};
    for (let i = 0; i < SEEN_SESSION_LIMIT; i++) seen = markSessionSeen(seen, id(i), "done");
    seen = markSessionSeen(seen, id(0), "new-done");
    seen = markSessionSeen(seen, id(SEEN_SESSION_LIMIT), "done");
    expect(Object.keys(seen)).toHaveLength(SEEN_SESSION_LIMIT);
    expect(seen).toHaveProperty(id(0), "new-done");
    expect(seen).not.toHaveProperty(id(1));
  });
  it("tolerates denied storage, corruption, oversized records and invalid identities", () => {
    expect(readSeenSessions({ getItem: () => { throw Error("denied"); } }, "owner")).toEqual({});
    for (const text of ["{", "[]", "null", "x".repeat(100_001)]) expect(readSeenSessions({ getItem: () => text }, "owner")).toEqual({});
    expect(readSeenSessions({ getItem: () => JSON.stringify({ invalid: "done", [id(1)]: "", [id(2)]: 2, [id(3)]: "x".repeat(129), [id(4)]: "done" }) }, "owner")).toEqual({ [id(4)]: "done" });
  });
});
