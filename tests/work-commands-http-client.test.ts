import { describe, expect, it, vi } from "vitest";
import { createWorkCommandsHttpClient } from "../packages/work-commands/src/http-client.js";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const target = { sourceId: "work-wsl", endpointId: "a".repeat(52) };
const request = { operationId: "00000000-0000-4000-8000-000000000001", cwd: "/fixture", command: "true", timeoutMs: 1000 };
const record = { ...request, state: "completed", payloadHash: "a".repeat(64), stdout: "", stderr: "", truncated: false, exitCode: 0, signal: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() };

describe("personal work HTTP client", () => {
  it("uses existing origin credentials, denies redirects and reads direct JSON", async () => {
    const fetch = vi.fn(async () => json([{ ...target, platform: "wsl", name: "Work WSL", available: true }]));
    const client = createWorkCommandsHttpClient({ origin: "https://agents.example.test", headers: () => ({ Origin: "https://agents.example.test", "Cf-Access-Jwt-Assertion": "synthetic" }), fetch: fetch as typeof globalThis.fetch });
    expect(await client.hosts()).toMatchObject([{ sourceId: "work-wsl" }]);
    expect(fetch.mock.calls[0]).toMatchObject(["https://agents.example.test/api/work-commands/hosts", { redirect: "error", credentials: "same-origin", cache: "no-store" }]);
    const headers = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers;
    expect(headers.get("Cf-Access-Jwt-Assertion")).toBe("synthetic");
  });
  it("accepts escaped bounded output, rejects an oversized stream and mismatched receipt", async () => {
    const fetch = vi.fn(async () => json({ ...record, stdout: "\u0001".repeat(128 * 1024) }));
    const client = createWorkCommandsHttpClient({ origin: "http://127.0.0.1", fetch: fetch as typeof globalThis.fetch });
    expect((await client.submit({ target, request })).stdout).toHaveLength(128 * 1024);
    fetch.mockImplementationOnce(async () => json({ ...record, stdout: "x".repeat(1_048_577) }));
    await expect(client.get({ target, operationId: request.operationId })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    fetch.mockImplementationOnce(async () => json({ ...record, command: "different" }));
    await expect(client.submit({ target, request })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("never exposes upstream error messages or sign-in HTML", async () => {
    const fetch = vi.fn(async () => json({ error: { code: "BUSY", message: "synthetic secret must not echo" } }, 409));
    const client = createWorkCommandsHttpClient({ origin: "http://127.0.0.1", fetch: fetch as typeof globalThis.fetch });
    await expect(client.submit({ target, request })).rejects.toThrow("already running");
    fetch.mockImplementationOnce(async () => new Response("synthetic sign-in secret", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(client.hosts()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    fetch.mockImplementationOnce(async () => json({}, 403));
    await expect(client.hosts()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
