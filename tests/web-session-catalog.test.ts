import { expect, it, vi } from "vitest";
import type { SessionRecord, SessionSearchPage } from "@arduano/agent-multiplex-protocol";
import { readSessionCatalog, SESSION_LIST_LIMIT } from "../apps/web/src/client/session-catalog.js";

const session = (sessionId: string) => ({ sessionId } as SessionRecord);
const signal = () => new AbortController().signal;

it("follows short and empty source pages with the same query fence", async () => {
  const pages: SessionSearchPage[] = [
    { sessions: [session("nas")], nextCursor: "next-host" },
    { sessions: [], nextCursor: "main-pc" },
    { sessions: [session("manifold")], nextCursor: null },
  ];
  const read = vi.fn(async () => pages.shift()!);
  expect(await readSessionCatalog(read, signal())).toEqual({ sessions: [session("nas"), session("manifold")], complete: true });
  expect(read.mock.calls).toEqual([
    [{ states: ["running", "stopped"], metadata: [], limit: 500 }],
    [{ states: ["running", "stopped"], metadata: [], limit: 500, cursor: "next-host" }],
    [{ states: ["running", "stopped"], metadata: [], limit: 500, cursor: "main-pc" }],
  ]);
});

it("deduplicates catalog identities between pages", async () => {
  const read = vi.fn()
    .mockResolvedValueOnce({ sessions: [session("same")], nextCursor: "second" })
    .mockResolvedValueOnce({ sessions: [session("same"), session("other")], nextCursor: null });
  expect((await readSessionCatalog(read, signal())).sessions.map(s => s.sessionId)).toEqual(["same", "other"]);
});

it("bounds the whole fleet and marks a truncated refresh incomplete", async () => {
  const fullPage = Array.from({ length: SESSION_LIST_LIMIT }, (_, i) => session(String(i)));
  const read = vi.fn()
    .mockResolvedValueOnce({ sessions: [session("nas")], nextCursor: "main-pc" })
    .mockResolvedValueOnce({ sessions: fullPage, nextCursor: null });
  const result = await readSessionCatalog(read, signal());
  expect(result.complete).toBe(false);
  expect(result.sessions).toHaveLength(SESSION_LIST_LIMIT);
  expect(read).toHaveBeenCalledTimes(2);
  expect(await readSessionCatalog(async () => ({ sessions: fullPage, nextCursor: null }), signal())).toEqual({ sessions: fullPage, complete: true });
  expect((await readSessionCatalog(async () => ({ sessions: fullPage, nextCursor: "more" }), signal())).complete).toBe(false);
});

it("rejects a failed later page instead of committing an authoritative partial list", async () => {
  const read = vi.fn()
    .mockResolvedValueOnce({ sessions: [session("nas")], nextCursor: "main-pc" })
    .mockRejectedValueOnce(new Error("source selection changed"));
  await expect(readSessionCatalog(read, signal())).rejects.toThrow("source selection changed");
});

it("cancels pagination before another request when a refresh is superseded", async () => {
  const controller = new AbortController();
  const read = vi.fn(async () => {
    controller.abort();
    return { sessions: [session("nas")], nextCursor: "main-pc" };
  });
  await expect(readSessionCatalog(read, controller.signal)).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
});

it("rejects repeated cursors and bounds empty-page traversal", async () => {
  await expect(readSessionCatalog(async () => ({ sessions: [], nextCursor: "same" }), signal())).rejects.toThrow("did not advance");
  let cursor = 0;
  const read = vi.fn(async () => ({ sessions: [], nextCursor: String(++cursor) }));
  expect(await readSessionCatalog(read, signal())).toEqual({ sessions: [], complete: false });
  expect(read).toHaveBeenCalledTimes(SESSION_LIST_LIMIT);
});
