import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { release } from "node:os";
import { z } from "zod";
import type { HostConfig } from "./config.js";
import { sharedSecret, verifyPrivateTarget, writePrivateFile } from "./private-state.js";
import { createWorkCommandExecutor } from "../../../packages/work-commands/src/executor.js";
import { createWorkCommandHost } from "../../../packages/work-commands/src/transport.js";

const workConfiguration = z.object({
  version: z.literal(1), platform: z.enum(["windows", "wsl"]),
}).strict();

/** Only the bespoke laptop installer creates this opt-in marker. */
export async function installedWorkCommands(config: HostConfig) {
  const filename = join(config.stateDirectory, "work-commands.json");
  let content: string;
  try { await verifyPrivateTarget(filename); content = await readFile(filename, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (config.harness !== "copilot") throw new Error("Work commands require the installed work Copilot profile");
  const marker = workConfiguration.parse(JSON.parse(content));
  if (marker.platform === "windows" ? process.platform !== "win32" : process.platform !== "linux" || !(process.env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(release()))) {
    throw new Error("The work command profile must run on its original Windows or WSL host");
  }
  return marker;
}

export async function startInstalledWorkCommands(config: HostConfig, signal: AbortSignal) {
  const marker = await installedWorkCommands(config);
  if (!marker || signal.aborted) return undefined;
  const stateDirectory = join(config.stateDirectory, "work-commands");
  const executor = await createWorkCommandExecutor({ stateDirectory, allowedRoots: config.allowedRoots, platform: marker.platform });
  let host: Awaited<ReturnType<typeof createWorkCommandHost>> | undefined;
  try {
    host = await createWorkCommandHost({ stateDirectory, sourceId: config.name, name: config.name,
      platform: marker.platform, sharedSecret: await sharedSecret(config.stateDirectory),
      enrollGateways: config.enrollGateways, bindAddress: marker.platform === "windows" ? "0.0.0.0:49121" : "0.0.0.0:49123", executor });
    await writePrivateFile(join(config.stateDirectory, "work-command-pairing.json"), JSON.stringify(host.pairing) + "\n");
    let closed: Promise<void> | undefined;
    const close = () => closed ??= host!.close().finally(() => executor.close());
    const stop = () => { void close().catch(() => undefined); };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) await close();
    return { pairing: host.pairing, close: async () => { signal.removeEventListener("abort", stop); await close(); } };
  } catch (error) { try { await host?.close(); } finally { await executor.close(); } throw error; }
}
