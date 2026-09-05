import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface HostConfig {
  readonly stateDirectory: string;
  readonly name: string;
  readonly codexConfigFile: string;
  readonly codexBinary: string;
  readonly controlPort: number;
  readonly p2pBindAddress: string;
  readonly enrollGateways: boolean;
  readonly enrollRuntimes: boolean;
}

export function hostConfig(environment: NodeJS.ProcessEnv = process.env): HostConfig {
  const userHome = environment.HOME ?? homedir();
  const state = environment.LEO_STATE_DIR ?? join(environment.XDG_STATE_HOME ?? join(userHome, ".local/state"), "leo-multiplex");
  const source = environment.LEO_CODEX_CONFIG_FILE ?? join(userHome, ".codex/config.toml");
  if (!isAbsolute(state) || !isAbsolute(source)) throw new Error("Leo state and Codex config paths must be absolute");
  const port = Number(environment.LEO_CONTROL_HTTP_PORT ?? "4317");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("LEO_CONTROL_HTTP_PORT must be a valid port");
  const enrollment = environment.LEO_ENROLL_GATEWAYS ?? "0";
  if (enrollment !== "0" && enrollment !== "1") throw new Error("LEO_ENROLL_GATEWAYS must be 0 or 1");
  const runtimeEnrollment = environment.LEO_ENROLL_RUNTIMES ?? "0";
  if (runtimeEnrollment !== "0" && runtimeEnrollment !== "1") throw new Error("LEO_ENROLL_RUNTIMES must be 0 or 1");
  return {
    stateDirectory: resolve(state),
    name: environment.LEO_HOST_NAME ?? "main-pc",
    codexConfigFile: resolve(source),
    codexBinary: environment.LEO_CODEX_BINARY ?? "codex",
    controlPort: port,
    p2pBindAddress: environment.LEO_CONTROL_P2P_BIND ?? "0.0.0.0:49117",
    enrollGateways: enrollment === "1",
    enrollRuntimes: runtimeEnrollment === "1",
  };
}
