import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newControlNodeId } from "@arduano/agent-multiplex-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { hostConfig } from "../apps/host/src/config.js";
import { codexEnvironment, createHostComponents, waitForControlSource } from "../apps/host/src/main.js";
import { writeControlArtifacts } from "../apps/host/src/control.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("constructs only a dedicated lazy Codex backend and strips deployment environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "leo-components-test-")); directories.push(directory);
  const oldHome = join(directory, ".codex"); await mkdir(oldHome);
  await writeFile(join(oldHome, "config.toml"), `model = "test-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nwire_api = "responses"\n[model_providers.fixture.auth]\ncommand = "/bin/cat"\nargs = ["/nonexistent/disposable-credential"]\n`);
  await writeFile(join(oldHome, "old-thread-sentinel"), "untouched");
  const config = hostConfig({ HOME: directory, LEO_CODEX_BINARY: "/nonexistent/never-started-codex" });
  const components = await createHostComponents(config, { HOME: directory, PATH: "/bin", CODEX_HOME: oldHome, LEO_PRIVATE: "fixture", AGENT_MULTIPLEX_SHARED_SECRET: "fixture" });
  expect(components.adapters).toHaveLength(1);
  expect(components.launchProviders?.map((provider) => provider.descriptor.providerId)).toEqual(["leo.local"]);
  expect(components.includeDirectWorkspaceProvider).toBe(false);
  expect(await readdir(oldHome)).toEqual(["config.toml", "old-thread-sentinel"]);
  expect(await readdir(join(config.stateDirectory, "codex"))).toEqual(["config.toml"]);
  expect(codexEnvironment("/managed", { HOME: directory, PATH: "/bin", CODEX_HOME: oldHome, LEO_SECRET: "fixture", AGENT_MULTIPLEX_SHARED_SECRET: "fixture" })).toEqual({ HOME: directory, PATH: "/bin", CODEX_HOME: "/managed" });
  await Promise.all(components.adapters.map((adapter) => adapter.close()));
});

it("writes private control/pairing artifacts without printing their contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "leo-artifact-test-")); directories.push(directory);
  const config = hostConfig({ HOME: directory, LEO_STATE_DIR: join(directory, "state") });
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const info = { controlNodeId: newControlNodeId(), endpointId: "fixture-endpoint", ticket: "fixture-locator", httpUrl: "http://127.0.0.1:4317" };
    await writeControlArtifacts(config, "fixture-shared-secret", info);
    const source = await waitForControlSource(config.stateDirectory, new AbortController().signal);
    expect(source).toMatchObject({ endpointId: info.endpointId, locator: { ticket: info.ticket } });
    const encoded = await readFile(join(config.stateDirectory, "control-source.json"), "utf8");
    expect(encoded).not.toContain("fixture-shared-secret");
    const pairing = JSON.parse(await readFile(join(config.stateDirectory, "gateway-pairing.json"), "utf8"));
    expect(pairing).toMatchObject({ version: 1, sharedSecret: "fixture-shared-secret", sources: [{ endpointId: info.endpointId }] });
    expect((await stat(join(config.stateDirectory, "gateway-pairing.json"))).mode & 0o777).toBe(0o600);
    expect(output).not.toHaveBeenCalled();
  } finally { output.mockRestore(); }
});
