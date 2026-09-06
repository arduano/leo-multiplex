import { describe, expect, it } from "vitest";
import { checkDraftBudget, documentBytes, DRAFT_BUDGET_BYTES } from "../apps/web/src/client/draft-storage.js";

describe("durable draft accounting", () => {
  it("counts UTF-8 text and image blob bytes, without URL inflation", () => {
    expect(documentBytes("🙂")).toBe(4);
    expect(documentBytes(new Blob([new Uint8Array(1024)]))).toBe(1024);
    expect(documentBytes({ prompt: "hello", images: [new Blob([new Uint8Array(1024)])] })).toBe(1041);
  });
  it("allows replacing a draft at the budget and refuses additional work without eviction", () => {
    expect(() => checkDraftBudget(DRAFT_BUDGET_BYTES, 1024, 1024)).not.toThrow();
    expect(() => checkDraftBudget(DRAFT_BUDGET_BYTES, 1024, 1025)).toThrow("256 MiB");
    expect(() => checkDraftBudget(DRAFT_BUDGET_BYTES, 1024, 0)).not.toThrow();
  });
});
