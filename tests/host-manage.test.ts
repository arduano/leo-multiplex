import { expect, it, vi } from "vitest";
import { parseLoginOptions, probeCopilot, type AuthProbe } from "../apps/host/src/manage.js";

function probe(overrides: Partial<AuthProbe> = {}): AuthProbe {
  return { start: vi.fn(async () => {}), getStatus: vi.fn(async () => ({ version: "1.0.81" })),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true, authType: "user" })), listModels: vi.fn(async () => [{}]),
    stop: vi.fn(async () => []), forceStop: vi.fn(async () => {}), ...overrides };
}

it("checks corporate auth and model discovery without needing any session/prompt API", async () => {
  const client = probe();
  expect(await probeCopilot(client)).toEqual([
    { name: "copilot-auth", status: "pass", message: "GitHub user authentication is available." },
    { name: "copilot-models", status: "pass", message: "1 models are available through GitHub Copilot." },
  ]);
  expect(client.forceStop).toHaveBeenCalledOnce();
});

it("refuses unauthenticated and environment-token auth before listing models", async () => {
  for (const auth of [{ isAuthenticated: false }, { isAuthenticated: true, authType: "env" }]) {
    const client = probe({ getAuthStatus: async () => auth });
    expect((await probeCopilot(client))[0]?.status).toBe("fail");
    expect(client.listModels).not.toHaveBeenCalled();
    expect(client.forceStop).toHaveBeenCalledOnce();
  }
});

it("bounds failed startup and withholds upstream errors and account details", async () => {
  const timeout = probe({ start: () => new Promise(() => {}) });
  expect((await probeCopilot(timeout, 10))[0]?.status).toBe("fail");
  expect(timeout.forceStop).toHaveBeenCalledOnce();
  const client = probe({ listModels: async () => { throw new Error("fixture-private-token private-user https://private-provider.invalid"); } });
  const output = JSON.stringify(await probeCopilot(client));
  expect(output).not.toMatch(/fixture-private|private-user|private-provider/);
  expect(client.forceStop).toHaveBeenCalledOnce();
});

it("supports native browser/device-code login with a validated enterprise hostname", () => {
  expect(parseLoginOptions([])).toEqual(["login"]);
  expect(parseLoginOptions(["--device-code", "--host", "https://company.ghe.com"])).toEqual(["login", "--device-code", "--host", "https://company.ghe.com"]);
  for (const args of [["--host", "http://company.ghe.com"], ["--host", "https://token@company.ghe.com"], ["--host", "https://company.ghe.com/?token=x"], ["--token", "fixture"], ["--device-code", "--device-code"]]) {
    expect(() => parseLoginOptions(args)).toThrow();
  }
});
