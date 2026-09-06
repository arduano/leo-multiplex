import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runControlNode, type ControlNodeReadyInfo } from "@arduano/agent-multiplex-control-node";
import { type ActionScope } from "@arduano/agent-multiplex-protocol";

import { hostConfig, type HostConfig } from "./config.js";
import { assertIsolatedState } from "./codex-config.js";
import { prepareCopilotHome } from "./copilot.js";
import { privateDirectory, sharedSecret, verifyPrivateTarget, writePrivateFile } from "./private-state.js";
import type { WorkHostPairing } from "../../../packages/work-commands/src/contract.js";

export const OPERATOR_SCOPES: readonly ActionScope[] = ["read", "agent-launch", "agent-archive", "agent-control", "terminal-view", "terminal-control", "metadata-propose"];

export async function writeControlArtifacts(config: HostConfig, secret: string, info: ControlNodeReadyInfo, workHost?: WorkHostPairing): Promise<void> {
  const source = {
    sourceId: config.name,
    displayName: config.name,
    controlNodeId: info.controlNodeId,
    endpointId: info.endpointId,
    locator: { kind: "ticket", ticket: info.ticket },
    priority: 0, enabled: true, requestedScopes: OPERATOR_SCOPES,
  };
  await writePrivateFile(join(config.stateDirectory, "control-source.json"), JSON.stringify({ version: 1, ...source }) + "\n");
  await writePrivateFile(join(config.stateDirectory, "gateway-pairing.json"), JSON.stringify({ version: 1, sharedSecret: secret, sources: [source], ...(workHost ? { workHosts: [workHost] } : {}) }) + "\n");
}

export async function runHostControl(config: HostConfig, signal: AbortSignal, ready?: () => void, workHost?: WorkHostPairing): Promise<void> {
  if (config.harness === "codex") await assertIsolatedState(config.codexConfigFile, config.stateDirectory);
  else await prepareCopilotHome(config);
  const secret = await sharedSecret(config.stateDirectory);
  const controlDirectory = join(config.stateDirectory, "control");
  await privateDirectory(controlDirectory);
  await verifyPrivateTarget(join(controlDirectory, "identity"));
  await runControlNode({
    sharedSecret: secret,
    statePath: join(controlDirectory, "catalog.sqlite"),
    identityPath: join(controlDirectory, "identity"),
    name: config.name,
    bindAddress: "127.0.0.1", port: config.controlPort,
    p2pBindAddress: config.p2pBindAddress,
    runtimeNodeStaleMs: 30_000, childControlNodeStaleMs: 30_000,
    enrollment: {
      runtimeNodes: config.enrollRuntimes, childControlNodes: false,
      accessGateways: config.enrollGateways, accessGatewayScopes: OPERATOR_SCOPES,
    },
    upstreamHeartbeatMs: 10_000, reconnectMaxMs: 30_000,
  }, signal, {
    printTicket: false,
    onReady: async (info) => { await writeControlArtifacts(config, secret, info, workHost); ready?.(); },
  });
}

const entrypoint = process.argv[1] ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href : undefined;
if (entrypoint === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { await runHostControl(hostConfig(), controller.signal); }
  catch { console.error("Leo control failed; inspect its private state and configuration."); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
