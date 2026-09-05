import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgentAdapter } from "@arduano/agent-multiplex-adapter-mock";
import { runtimeBackendForAdapter, type LaunchPreparationContext, type LaunchResumeContext } from "@arduano/agent-multiplex-runtime-node-core";
import { afterEach, expect, it } from "vitest";
import { LeoWorkspaceLaunchProvider } from "../packages/launch/src/index.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("launches and resumes only existing directories with explicit full-access defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "leo-launch-test-")); directories.push(cwd);
  const backend = runtimeBackendForAdapter(new MockAgentAdapter());
  const provider = new LeoWorkspaceLaunchProvider(backend);
  const context = { request: { harness: "codex", input: { cwd, model: "selected-model" } } } as unknown as LaunchPreparationContext;
  const prepared = await provider.prepare(context);
  expect(prepared.spawnOptions).toEqual({ harness: "codex", cwd, model: "selected-model", approvalPolicy: "never", sandbox: "danger-full-access" });
  const resumed = await provider.prepareResume({ prepared, defaults: { harness: "codex", cwd, vendorSessionId: "fixture-session" } } as LaunchResumeContext);
  expect(resumed.resumeOptions).toMatchObject({ vendorSessionId: "fixture-session", approvalPolicy: "never", sandbox: "danger-full-access" });
  const file = join(cwd, "file"); await writeFile(file, "fixture");
  await expect(provider.prepare({ request: { harness: "codex", input: { cwd: file } } } as unknown as LaunchPreparationContext)).rejects.toThrow("existing directory");
  await provider.release();
  await expect((await import("node:fs/promises")).stat(cwd)).resolves.toBeDefined();
  await backend.adapter.close();
});

it("fills complete native Plan settings from selected model defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "leo-plan-test-")); directories.push(cwd);
  const adapter = new MockAgentAdapter();
  const provider = new LeoWorkspaceLaunchProvider(runtimeBackendForAdapter(adapter), { model: "default-model", effort: "high" });
  const result = await provider.prepare({ request: { harness: "codex", input: { cwd, mode: "plan" } } } as unknown as LaunchPreparationContext);
  expect(result.spawnOptions).toMatchObject({ collaborationMode: { mode: "plan", settings: { model: "default-model", reasoning_effort: "high", developer_instructions: null } } });
  await adapter.close();
});

it("rejects policy overrides and relative launch directories", () => {
  const provider = new LeoWorkspaceLaunchProvider(runtimeBackendForAdapter(new MockAgentAdapter()));
  expect(() => provider.validateInput({ cwd: "relative" }, "codex")).toThrow("absolute");
  expect(() => provider.validateInput({ cwd: "/tmp", native: { approvalPolicy: "on-request" } }, "codex")).toThrow("Unsupported");
  expect(provider.descriptor).toMatchObject({ providerId: "leo.local", profileId: "workspace" });
});
