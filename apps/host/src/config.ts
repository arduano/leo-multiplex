import { homedir, hostname } from "node:os";
import { posix, win32 } from "node:path";

export interface HostConfig {
  readonly stateDirectory: string;
  readonly name: string;
  readonly codexConfigFile: string;
  readonly codexBinary: string;
  readonly controlPort: number;
  readonly p2pBindAddress: string;
  readonly enrollGateways: boolean;
  readonly enrollRuntimes: boolean;
  readonly harness: "codex" | "copilot";
  readonly allowedRoots: readonly string[];
  readonly copilotHome: string;
  readonly copilotGithubHost: string;
}

export function hostConfig(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): HostConfig {
  const { isAbsolute, join, resolve } = platform === "win32" ? win32 : posix;
  const userHome = (platform === "win32" ? environment.USERPROFILE : environment.HOME) ?? homedir();
  const harness = environment.LEO_HARNESS ?? "codex";
  if (harness !== "codex" && harness !== "copilot") throw new Error("LEO_HARNESS must be codex or copilot");
  const state = environment.LEO_STATE_DIR ?? join(platform === "win32"
    ? environment.LOCALAPPDATA ?? join(userHome, "AppData", "Local")
    : environment.XDG_STATE_HOME ?? join(userHome, ".local/state"), harness === "copilot" ? "leo-multiplex-copilot" : "leo-multiplex");
  const source = environment.LEO_CODEX_CONFIG_FILE ?? join(userHome, ".codex/config.toml");
  if (!isAbsolute(state) || (harness === "codex" && !isAbsolute(source))) throw new Error("Leo state and Codex config paths must be absolute");
  if (platform === "win32" && !/^[a-z]:[\\/]/i.test(state)) throw new Error("Windows state must use an absolute path on a local drive");
  let roots: unknown = harness === "codex" ? ["/"] : [userHome];
  if (environment.LEO_ALLOWED_ROOTS !== undefined) {
    try { roots = JSON.parse(environment.LEO_ALLOWED_ROOTS); }
    catch { throw new Error("LEO_ALLOWED_ROOTS must be a JSON array of absolute directories"); }
  }
  if (!Array.isArray(roots) || roots.length === 0 || roots.some(root => typeof root !== "string" || !isAbsolute(root))) {
    throw new Error("LEO_ALLOWED_ROOTS must be a nonempty JSON array of absolute directories");
  }
  const copilotGithubHost = environment.LEO_COPILOT_GITHUB_HOST ?? "github.com";
  if (!/^(github\.com|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com)$/.test(copilotGithubHost)) throw new Error("LEO_COPILOT_GITHUB_HOST must be github.com or the corporate Enterprise Cloud hostname");
  const port = Number(environment.LEO_CONTROL_HTTP_PORT ?? "4317");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LEO_CONTROL_HTTP_PORT must be a valid port");
  const enrollment = environment.LEO_ENROLL_GATEWAYS ?? "0";
  if (enrollment !== "0" && enrollment !== "1") throw new Error("LEO_ENROLL_GATEWAYS must be 0 or 1");
  const runtimeEnrollment = environment.LEO_ENROLL_RUNTIMES ?? "0";
  if (runtimeEnrollment !== "0" && runtimeEnrollment !== "1") throw new Error("LEO_ENROLL_RUNTIMES must be 0 or 1");
  return {
    stateDirectory: resolve(state),
    name: environment.LEO_HOST_NAME ?? (harness === "copilot" ? hostname() : "main-pc"),
    codexConfigFile: resolve(source),
    codexBinary: environment.LEO_CODEX_BINARY ?? "codex",
    controlPort: port,
    p2pBindAddress: environment.LEO_CONTROL_P2P_BIND ?? "0.0.0.0:49117",
    enrollGateways: enrollment === "1",
    enrollRuntimes: runtimeEnrollment === "1",
    harness,
    allowedRoots: roots.map(root => resolve(root as string)),
    copilotHome: join(resolve(state), "copilot"),
    copilotGithubHost,
  };
}
