import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type { HostConfig } from "./config.js";
import { copilotClientOptions } from "./copilot.js";
import { verifyPrivateTarget, writePrivateFile } from "./private-state.js";

export interface CopilotAccount { login: string; host: string }
export function signedInAccount(auth: { isAuthenticated: boolean; authType?: string; login?: string; host?: string }): CopilotAccount | undefined {
  if (!auth.isAuthenticated || auth.authType !== "user" || !auth.login || !auth.host) return;
  try {
    const host = new URL(auth.host.includes("://") ? auth.host : `https://${auth.host}`).hostname.toLowerCase();
    return { login: auth.login.toLowerCase(), host };
  } catch { return; }
}

export async function readCopilotAccount(config: HostConfig): Promise<CopilotAccount | undefined> {
  try {
    await verifyPrivateTarget(join(config.stateDirectory, "copilot-account.json"));
    const value = JSON.parse(await readFile(join(config.stateDirectory, "copilot-account.json"), "utf8"));
    if (value.version !== 1 || typeof value.login !== "string" || !value.login || value.host !== config.copilotGithubHost) return;
    return { login: value.login, host: value.host };
  } catch { return; }
}

/** Called only after successful native login; never records an OAuth token. */
export async function recordCopilotAccount(config: HostConfig, environment: NodeJS.ProcessEnv): Promise<void> {
  const client = new CopilotClient(copilotClientOptions(config, environment));
  let timer: NodeJS.Timeout | undefined;
  try {
    const account = await Promise.race([
      (async () => { await client.start(); return signedInAccount(await client.getAuthStatus()); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Copilot account verification timed out")), 20_000); }),
    ]);
    if (!account || account.host !== config.copilotGithubHost) throw new Error("Copilot must use the configured GitHub user login; gh CLI fallback and token overrides are not accepted");
    await writePrivateFile(join(config.stateDirectory, "copilot-account.json"), JSON.stringify({ version: 1, ...account }) + "\n");
  } finally { if (timer) clearTimeout(timer); await client.forceStop().catch(() => undefined); }
}
