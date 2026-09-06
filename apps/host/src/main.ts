import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createCodexRuntime } from "@arduano/agent-multiplex-adapter-codex";
import { CopilotAgentAdapter } from "@arduano/agent-multiplex-adapter-copilot";
import { runRuntimeNode, type RuntimeComponents, type RuntimeNodeAppConfig } from "@arduano/agent-multiplex-runtime-node";
import { runtimeBackendForAdapter } from "@arduano/agent-multiplex-runtime-node-core";
import { z } from "zod";

import { LeoWorkspaceLaunchProvider } from "../../../packages/launch/src/index.js";
import { LeoCopilotLaunchProvider } from "../../../packages/launch/src/copilot.js";
import { hostConfig, type HostConfig } from "./config.js";
import { assertIsolatedState, prepareManagedCodexConfig } from "./codex-config.js";
import { privateDirectory, sharedSecret } from "./private-state.js";
import { copilotClientOptions, prepareCopilotHome } from "./copilot.js";

const sourceSchema = z.object({
  version: z.literal(1), endpointId: z.string().min(1),
  locator: z.object({ kind: z.literal("ticket"), ticket: z.string().min(1) }),
});

export async function waitForControlSource(stateDirectory: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try { return sourceSchema.parse(JSON.parse(await readFile(join(stateDirectory, "control-source.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The private control-source configuration is invalid");
      await delay(250, undefined, { signal });
    }
  }
  throw new Error("Runtime startup cancelled");
}

/** Preserve the user's toolchain while withholding deployment configuration from native children. */
export function codexEnvironment(home: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(LEO_|AGENT_MULTIPLEX_)/i.test(key))),
    CODEX_HOME: home,
  };
}

export async function createHostComponents(config: HostConfig, environment: NodeJS.ProcessEnv = process.env): Promise<RuntimeComponents> {
  if (config.harness === "copilot") {
    await prepareCopilotHome(config, environment);
    const adapter = new CopilotAgentAdapter({
      adapterScopeId: `copilot:leo:${config.name}`, clientOptions: copilotClientOptions(config, environment),
    });
    return {
      adapters: [adapter], terminalProviders: [],
      launchProviders: [new LeoCopilotLaunchProvider(runtimeBackendForAdapter(adapter))],
      includeDirectWorkspaceProvider: false,
    };
  }
  const managed = await prepareManagedCodexConfig(config.codexConfigFile, config.stateDirectory);
  const bundle = createCodexRuntime({
    binary: config.codexBinary, adapterScopeId: `codex:leo:${config.name}`,
    cwd: config.stateDirectory, environment: codexEnvironment(managed.home, environment),
    args: ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"', "app-server"],
  });
  const backend = runtimeBackendForAdapter(bundle.adapter);
  return {
    adapters: [bundle.adapter], terminalProviders: [bundle.terminalProvider],
    launchProviders: [new LeoWorkspaceLaunchProvider(backend, { model: managed.model, ...(managed.effort === undefined ? {} : { effort: managed.effort }) })],
    includeDirectWorkspaceProvider: false,
  };
}

export async function runHost(config: HostConfig, signal: AbortSignal): Promise<void> {
  if (config.harness === "codex") await assertIsolatedState(config.codexConfigFile, config.stateDirectory);
  else await prepareCopilotHome(config);
  const secret = await sharedSecret(config.stateDirectory);
  const source = await waitForControlSource(config.stateDirectory, signal);
  const runtimeDirectory = join(config.stateDirectory, "runtime");
  await privateDirectory(runtimeDirectory);
  const runtimeConfig: RuntimeNodeAppConfig = {
    stateDirectory: runtimeDirectory, runtimeNodeName: config.name,
    allowedRoots: config.allowedRoots, enabledHarnesses: new Set([config.harness]), adapterMode: "native",
    sharedSecret: secret, controlNode: { endpointId: source.endpointId, locator: source.locator },
    heartbeatMs: 10_000, inventoryRefreshMs: 60_000, metadataFlushMs: 5_000,
    reconnectMaxMs: 30_000, maxRunningTerminals: 16,
    copilotExperimentalUiServer: false,
  };
  await runRuntimeNode(runtimeConfig, signal, { createComponents: () => createHostComponents(config) });
}

const entrypoint = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : undefined;
if (entrypoint === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await runHost(hostConfig(), controller.signal); }
  catch { if (!controller.signal.aborted) { console.error("Leo runtime failed; inspect its private state and configuration."); process.exitCode = 1; } }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
