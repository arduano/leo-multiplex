import { describe, expect, it } from "vitest";
import type { NativeModel } from "@arduano/agent-multiplex-protocol";
import { reasoningOptions, resolveSlash, slashSuggestions } from "../apps/web/src/client/slash-commands.js";
const models: NativeModel[] = [
  { harness: "codex", id: "fast-model", name: "Fast model", native: { supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick responses" }, { reasoningEffort: "high", description: "Thorough" }] } },
  { harness: "codex", id: "deep-model", name: "Deep model", native: { supportedReasoningEfforts: [{ reasoningEffort: "ultra", description: "Deep work" }] } },
];
const context = { harness: "codex" as const, models, model: "fast-model", running: false };
describe("composer slash commands", () => {
  it.each(["/plan", "/plan on", " /PLAN "])("maps %s to an explicit plan setting", input => {
    expect(resolveSlash(input, context)).toMatchObject({ kind: "command", request: { harness: "codex", command: { type: "setMode", mode: "plan" } } });
  });
  it.each(["/plan off", "/default", "/mode default"])("maps %s to normal agent mode", input => {
    expect(resolveSlash(input, context)).toMatchObject({ kind: "command", request: { command: { type: "setMode", mode: "default" } } });
  });
  it("preserves Copilot's native modes and excludes Codex-only effort", () => {
    expect(resolveSlash("/default", { ...context, harness: "copilot" })).toMatchObject({ request: { harness: "copilot", command: { mode: "interactive" } } });
    expect(resolveSlash("/mode autopilot", { ...context, harness: "copilot" })).toMatchObject({ request: { command: { mode: "autopilot" } } });
    expect(resolveSlash("/effort high", { ...context, harness: "copilot" }).kind).toBe("error");
    expect(slashSuggestions("/", "copilot").some(item => item.name === "effort")).toBe(false);
  });
  it("opens settings without sending slash text to a model", () => {
    for (const command of ["model", "mode", "effort"]) expect(resolveSlash(`/${command}`, context)).toEqual({ kind: "settings", section: command });
  });
  it("uses the exact catalog model ID, allowing only unique full display names", () => {
    expect(resolveSlash("/model Fast model", context)).toMatchObject({ request: { command: { type: "setModel", model: "fast-model" } } });
    expect(resolveSlash("/model deep-model", context)).toMatchObject({ request: { command: { model: "deep-model" } } });
    expect(resolveSlash("/model fast", context).kind).toBe("error");
    expect(resolveSlash("/model Fast model", { ...context, models: [models[0]!, { ...models[0]!, id: "other" }] }).kind).toBe("error");
  });
  it("accepts only reasoning levels advertised for the applied model", () => {
    expect(resolveSlash("/effort high", context)).toMatchObject({ request: { command: { type: "setEffort", effort: "high" } } });
    expect(resolveSlash("/effort ultra", context).kind).toBe("error");
    expect(resolveSlash("/effort ultra", { ...context, model: "deep-model" })).toMatchObject({ kind: "command" });
    expect(resolveSlash("/effort high", { ...context, model: undefined }).kind).toBe("error");
    expect(reasoningOptions({ harness: "codex", id: "unknown" })).toEqual([]);
  });
  it.each(["/compact", "/unknown", "/plan write a plan", "/model fast-model then run", "/mode autopilot", "/help extra"])("rejects unsupported or ambiguous %s locally", input => {
    expect(resolveSlash(input, context).kind).toBe("error");
  });
  it("requires a running turn to interrupt", () => {
    expect(resolveSlash("/interrupt", context).kind).toBe("error");
    expect(resolveSlash("/interrupt", { ...context, running: true })).toMatchObject({ request: { command: { type: "interrupt" } } });
  });
  it("keeps ordinary messages, paths, and literal slash escaping intact", () => {
    for (const text of ["Discuss /model and /plan", "/home/leo/project", "/image.png", "Here is a plan:\n/plan"]) expect(resolveSlash(text, context)).toEqual({ kind: "message", text });
    expect(resolveSlash("//plan", context)).toEqual({ kind: "message", text: "/plan" });
    expect(resolveSlash("  //unknown words", context)).toEqual({ kind: "message", text: "  /unknown words" });
  });
  it("only suggests commands for a single prefix, avoiding long-prompt scans", () => {
    expect(slashSuggestions("/mo", "codex").map(item => item.name)).toEqual(["model", "mode"]);
    expect(slashSuggestions("/model arg", "codex")).toEqual([]);
    expect(slashSuggestions("hello".repeat(200_000), "codex")).toEqual([]);
  });
});
