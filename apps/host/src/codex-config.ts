import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "smol-toml";

import { privateDirectory, writePrivateFile } from "./private-state.js";

export interface ManagedCodexConfig {
  readonly home: string;
  readonly model: string;
  readonly provider: string;
  readonly effort?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Select configuration, never execute its auth helper or open credential files. */
export function selectCodexConfig(source: string): { content: string; model: string; provider: string; effort?: string } {
  let parsed: Record<string, unknown>;
  try { parsed = parse(source); } catch { throw new Error("The source Codex configuration is invalid TOML"); }
  const model = parsed.model;
  const provider = parsed.model_provider;
  if (typeof model !== "string" || !model || typeof provider !== "string" || !provider) {
    throw new Error("The source Codex configuration must select a model and custom provider");
  }
  const selected = object(object(parsed.model_providers)?.[provider]);
  if (!selected || !object(selected.auth) || selected.requires_openai_auth === true) {
    throw new Error("The selected Codex provider must use command authentication");
  }
  const auth = object(selected.auth)!;
  if (typeof auth.command !== "string" || !auth.command.startsWith("/") ||
    (auth.args !== undefined && (!Array.isArray(auth.args) || auth.args.some((v) => typeof v !== "string")))) {
    throw new Error("The Codex authentication helper must use an absolute executable and string arguments");
  }
  const config = {
    model,
    model_provider: provider,
    model_providers: { [provider]: selected },
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
    check_for_update_on_startup: false,
    ...(typeof parsed.model_reasoning_effort === "string" ? { model_reasoning_effort: parsed.model_reasoning_effort } : {}),
  };
  return { content: stringify(config), model, provider,
    ...(typeof parsed.model_reasoning_effort === "string" ? { effort: parsed.model_reasoning_effort } : {}),
  };
}

function inside(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

async function canonicalFuturePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalFuturePath(dirname(path)), basename(path));
  }
}

export async function prepareManagedCodexConfig(sourceFile: string, stateDirectory: string): Promise<ManagedCodexConfig> {
  await assertIsolatedState(sourceFile, stateDirectory);
  const source = await realpath(sourceFile);
  const sourceHomes = [dirname(source), await realpath(dirname(sourceFile))];
  await privateDirectory(stateDirectory);
  const canonicalState = await realpath(stateDirectory);
  if (sourceHomes.some((sourceHome) => inside(sourceHome, canonicalState))) throw new Error("Managed state must be outside the existing Codex home");
  const home = join(canonicalState, "codex");
  await privateDirectory(home);
  const canonicalHome = await realpath(home);
  if (sourceHomes.some((sourceHome) => inside(sourceHome, canonicalHome))) throw new Error("Managed Codex home must be isolated");
  const selected = selectCodexConfig(await readFile(source, "utf8"));
  await writePrivateFile(join(home, "config.toml"), selected.content);
  return { home, model: selected.model, provider: selected.provider,
    ...(selected.effort === undefined ? {} : { effort: selected.effort }),
  };
}

/** Preflight before creating any host state, including the control catalog. */
export async function assertIsolatedState(sourceFile: string, stateDirectory: string): Promise<void> {
  const sourceHomes = [dirname(await realpath(sourceFile)), await realpath(dirname(sourceFile))];
  const futureState = await canonicalFuturePath(resolve(stateDirectory));
  if (sourceHomes.some((sourceHome) => inside(sourceHome, futureState))) {
    throw new Error("Managed state must be outside the existing Codex home");
  }
}
