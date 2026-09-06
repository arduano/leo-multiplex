import { createRequire } from "node:module";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RuntimeConnection, type CopilotClientOptions } from "@github/copilot-sdk";
import type { HostConfig } from "./config.js";
import { privateDirectory } from "./private-state.js";

/** Corporate OAuth owns this process. Ambient personal providers/tokens cannot override it. */
export function copilotEnvironment(home: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) =>
      !/^(LEO_|AGENT_MULTIPLEX_|CODEX_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|COPILOT_)/i.test(key)
      && !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(key))),
    COPILOT_HOME: home,
  };
}

/** Resolve the shipped native executable, never an npm .cmd shim or a mutable PATH alias. */
export function copilotExecutable(): string {
  const require = createRequire(import.meta.url);
  const candidates = process.platform === "linux"
    ? [`@github/copilot-linux-${process.arch}`, `@github/copilot-linuxmusl-${process.arch}`]
    : [`@github/copilot-${process.platform}-${process.arch}`];
  for (const candidate of candidates) {
    try { return require.resolve(candidate); } catch { /* Try the other libc package. */ }
  }
  throw new Error("The pinned native Copilot executable is missing; reinstall with optional dependencies enabled");
}

export function copilotClientOptions(config: HostConfig, environment: NodeJS.ProcessEnv = process.env): CopilotClientOptions {
  return {
    mode: "copilot-cli", connection: RuntimeConnection.forStdio({ path: copilotExecutable() }),
    baseDirectory: config.copilotHome, workingDirectory: config.stateDirectory,
    useLoggedInUser: true, env: copilotEnvironment(config.copilotHome, environment), logLevel: "error",
  };
}

async function canonicalFuturePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalFuturePath(dirname(path)), basename(path));
  }
}

function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

export async function prepareCopilotHome(config: HostConfig, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const userHome = (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) ?? homedir();
  const state = await canonicalFuturePath(resolve(config.stateDirectory));
  const ordinary = await canonicalFuturePath(join(userHome, ".copilot"));
  if (inside(ordinary, state)) throw new Error("Managed state must be outside the existing Copilot home");
  await privateDirectory(config.stateDirectory);
  await privateDirectory(config.copilotHome);
}
