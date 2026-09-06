import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runtimeBackendForAdapter, type LaunchPreparationContext, type LaunchResumeContext } from "@arduano/agent-multiplex-runtime-node-core";
import { hostConfig } from "../apps/host/src/config.js";
import { copilotClientOptions, copilotEnvironment, prepareCopilotHome } from "../apps/host/src/copilot.js";
import { createHostComponents } from "../apps/host/src/main.js";
import { LeoCopilotLaunchProvider } from "../packages/launch/src/copilot.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const path = await mkdtemp(join(tmpdir(), "leo-copilot-")); directories.push(path); return path; }

it("uses local Windows state and configurable roots without needing Codex configuration", () => {
  const config = hostConfig({ USERPROFILE: "C:\\Users\\Leo", LOCALAPPDATA: "C:\\Users\\Leo\\AppData\\Local", LEO_HARNESS: "copilot", LEO_ALLOWED_ROOTS: '["C:\\\\Work","D:\\\\Projects"]' }, "win32");
  expect(config.stateDirectory).toBe("C:\\Users\\Leo\\AppData\\Local\\leo-multiplex");
  expect(config.copilotHome).toBe(`${config.stateDirectory}\\copilot`);
  expect(config.allowedRoots).toEqual(["C:\\Work", "D:\\Projects"]);
  expect(config.enrollGateways).toBe(false);
  expect(() => hostConfig({ LEO_HARNESS: "other" })).toThrow("LEO_HARNESS");
  expect(() => hostConfig({ LEO_HARNESS: "copilot", LEO_ALLOWED_ROOTS: "secret-invalid-json" })).toThrow("JSON array");
  expect(() => hostConfig({ LEO_STATE_DIR: "\\\\server\\share\\state" }, "win32")).toThrow("local drive");
});

it("withholds all ambient provider/token overrides while preserving corporate proxy and CA settings", () => {
  const env = copilotEnvironment("/private/copilot", {
    HOME: "/home/fixture", PATH: "/bin", HTTPS_PROXY: "http://proxy.invalid", NODE_EXTRA_CA_CERTS: "/corp.pem",
    COPILOT_PROVIDER_BASE_URL: "fixture-private", COPILOT_GITHUB_TOKEN: "fixture", COPILOT_SDK_AUTH_TOKEN: "fixture",
    COPILOT_OFFLINE: "1", COPILOT_CLI_PATH: "fixture", COPILOT_HOME: "/ordinary",
    GH_TOKEN: "fixture", GITHUB_TOKEN: "fixture", GH_ENTERPRISE_TOKEN: "fixture", GITHUB_ENTERPRISE_TOKEN: "fixture",
    LEO_SECRET: "fixture", AGENT_MULTIPLEX_SECRET: "fixture", CODEX_HOME: "/ordinary", OPENAI_API_KEY: "fixture",
    copilot_provider_base_url: "case-insensitive-fixture",
  });
  expect(env).toEqual({ HOME: "/home/fixture", PATH: "/bin", HTTPS_PROXY: "http://proxy.invalid", NODE_EXTRA_CA_CERTS: "/corp.pem", COPILOT_HOME: "/private/copilot" });
});

it("builds only a lazy Copilot adapter with isolated OAuth and no terminal or provider override", async () => {
  const home = await fixture();
  const ordinary = join(home, ".copilot"); await mkdir(ordinary); await writeFile(join(ordinary, "sentinel"), "untouched");
  const config = hostConfig({ HOME: home, LEO_HARNESS: "copilot" });
  const options = copilotClientOptions(config, { HOME: home, OPENAI_API_KEY: "fixture" });
  expect(options).toMatchObject({ useLoggedInUser: true, baseDirectory: config.copilotHome, mode: "copilot-cli" });
  expect(options.gitHubToken).toBeUndefined();
  const components = await createHostComponents(config, { HOME: home });
  try {
    expect(components.adapters.map(adapter => adapter.harness)).toEqual(["copilot"]);
    expect(components.terminalProviders).toEqual([]);
    expect(components.launchProviders?.[0]?.descriptor).toMatchObject({ providerId: "leo.local", profileId: "copilot-workspace", harnesses: ["copilot"] });
    expect(await readdir(ordinary)).toEqual(["sentinel"]);
    expect(await readdir(config.copilotHome)).toEqual([]);
    expect(await readdir(config.stateDirectory)).not.toContain("codex");
  } finally { await Promise.all(components.adapters.map(adapter => adapter.close())); }
  await expect(prepareCopilotHome({ ...config, stateDirectory: join(ordinary, "managed"), copilotHome: join(ordinary, "managed", "copilot") }, { HOME: home })).rejects.toThrow("outside");
});

it("preserves Copilot launch/resume semantics and rejects credential and policy passthrough", async () => {
  const home = await fixture();
  const components = await createHostComponents(hostConfig({ HOME: home, LEO_HARNESS: "copilot" }), { HOME: home });
  const adapter = components.adapters[0]!;
  const provider = new LeoCopilotLaunchProvider(runtimeBackendForAdapter(adapter));
  try {
    const prepared = await provider.prepare({ request: { harness: "copilot", input: { cwd: home, model: "corporate-model", mode: "plan" } } } as unknown as LaunchPreparationContext);
    expect(prepared.spawnOptions).toEqual({ harness: "copilot", cwd: home, model: "corporate-model", mode: "plan" });
    const resumed = await provider.prepareResume({ prepared, defaults: { harness: "copilot", cwd: home, vendorSessionId: "fixture-session", continuePendingWork: false, mode: "plan" } } as LaunchResumeContext);
    expect(resumed.resumeOptions).toMatchObject({ continuePendingWork: false, mode: "plan", vendorSessionId: "fixture-session" });
    for (const input of [{ cwd: home, provider: {} }, { cwd: home, native: {} }, { cwd: home, effort: "high" }, { cwd: home, approvalPolicy: "never" }]) {
      expect(() => provider.validateInput(input, "copilot")).toThrow("Unsupported");
    }
    expect(() => provider.validateInput({ cwd: home }, "codex")).toThrow("supports Copilot");
    expect(() => provider.validateInput({ cwd: "relative" }, "copilot")).toThrow("absolute");
    expect(() => provider.validateInput({ cwd: home, mode: "default" }, "copilot")).toThrow("mode");
    await provider.release();
    expect(await readdir(home)).toBeDefined();
  } finally { await adapter.close(); }
});
