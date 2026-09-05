import { expect, it } from "vitest";
import type { SessionRecord, SourceDiagnostic } from "@arduano/agent-multiplex-protocol";
import { retainSessionRows } from "../apps/web/src/client/session-retention.js";

const session = { sessionId: "session-a", metadataAuthority: { controlNodeId: "control-a" } } as SessionRecord;
const source = { state: "selected", manifest: { coveredControlNodeIds: ["control-a"] } } as SourceDiagnostic;

it("retains absent sessions as stale when a host disconnects and replaces them on recovery", () => {
  const live = retainSessionRows([], [session], [source], true);
  expect(live).toEqual([{ session, stale: false }]);
  const offline = retainSessionRows(live, [], [{ ...source, state: "unavailable", manifest: null }], true);
  expect(offline).toEqual([{ session, stale: true }]);
  const updated = { ...session, cwd: "/updated" };
  expect(retainSessionRows(offline, [updated], [source], true)).toEqual([{ session: updated, stale: false }]);
});

it("allows only a fresh selected authority to remove a cached row", () => {
  const cached = [{ session, stale: true }];
  for (const state of ["unavailable", "connecting", "synchronizing", "conflict", "disabled", "suppressed"] as const) {
    expect(retainSessionRows(cached, [], [{ ...source, state }], true)).toEqual(cached);
  }
  expect(retainSessionRows(cached, [], [source], false)).toEqual(cached);
  expect(retainSessionRows(cached, [], [source], true, false)).toEqual(cached);
  expect(retainSessionRows(cached, [], [source], true)).toEqual([]);
});

it("marks cached query results stale during gateway or login failure and bounds retained rows", () => {
  expect(retainSessionRows([], [session], [source], false)).toEqual([{ session, stale: true }]);
  const previous = Array.from({ length: 600 }, (_, index) => ({ session: { ...session, sessionId: String(index) } as SessionRecord, stale: false }));
  expect(retainSessionRows(previous, [], [], false)).toHaveLength(500);
});
