import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { RuntimeNodeStore } from "@arduano/agent-multiplex-runtime-node-core";
import { hostConfig, type HostConfig } from "./config.js";
import { copilotClientOptions, copilotEnvironment, copilotExecutable, prepareCopilotHome } from "./copilot.js";
import { runHostControl } from "./control.js";
import { runHost } from "./main.js";
import { importEnrollmentSecret } from "./enrollment.js";
import { privateDirectory } from "./private-state.js";

export interface DoctorCheck { name: string; status: "pass" | "fail" | "manual"; message: string }
export interface DoctorReport { version: 1; ok: boolean; checks: DoctorCheck[] }
export interface AuthProbe {
  start(): Promise<void>;
  getStatus(): Promise<{ version: string }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; authType?: string }>;
  listModels(): Promise<unknown[]>;
  stop(): Promise<unknown>;
  forceStop(): Promise<void>;
}

/** A no-prompt probe; only fixed text, versions, and counts enter its report. */
export async function probeCopilot(client: AuthProbe, timeoutMs = 20_000): Promise<DoctorCheck[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async (): Promise<DoctorCheck[]> => {
        await client.start();
        const status = await client.getStatus();
        if (status.version !== "1.0.81") return [{ name: "copilot", status: "fail", message: "Copilot version differs from the pinned CLI 1.0.81; reinstall the locked dependencies." }];
        const auth = await client.getAuthStatus();
        if (!auth.isAuthenticated || !["user", "gh-cli"].includes(auth.authType ?? "")) {
          return [{ name: "copilot-auth", status: "fail", message: "Corporate GitHub sign-in is required. Run leo-host login, verify the corporate account in the browser, then retry doctor." }];
        }
        const models = await client.listModels();
        return [{ name: "copilot-auth", status: "pass", message: "GitHub user authentication is available." },
          { name: "copilot-models", status: models.length ? "pass" : "fail", message: models.length ? `${models.length} models are available through GitHub Copilot.` : "No models are available; check the corporate Copilot subscription and organization policy." }];
      })(),
      new Promise<DoctorCheck[]>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
  } catch {
    return [{ name: "copilot", status: "fail", message: "Copilot did not complete its authentication/model probe. Check sign-in, GitHub policy, approved proxy and CA settings; no prompt was sent." }];
  } finally {
    if (timer) clearTimeout(timer);
    // forceStop is SDK-owned process cleanup, including an incomplete start.
    await client.forceStop().catch(() => undefined);
  }
}

export async function doctor(config: HostConfig, environment: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const supported = (process.platform === "win32" && process.arch === "x64") || (process.platform === "linux" && process.arch === "x64");
  checks.push({ name: "platform", status: supported ? "pass" : "fail", message: supported ? "Windows/Linux x64 target detected." : "This host path targets Windows x64 and Linux x64; the pinned transport has no Windows ARM64 package." });
  checks.push({ name: "node", status: Number(process.versions.node.split(".")[0]) >= 24 ? "pass" : "fail", message: `Node ${process.versions.node}; Node 24 or newer is required.` });
  let stateReady = false;
  try {
    await prepareCopilotHome(config, environment);
    stateReady = true;
    checks.push({ name: "private-state", status: "pass", message: "Managed state has the required private directory permissions." });
  } catch {
    checks.push({ name: "private-state", status: "fail", message: "Private state could not be established. Native Windows requires the framework ACL update; an existing unsafe directory must be reviewed locally." });
  }
  if (stateReady) {
    let scratch: string | undefined;
    try {
      scratch = join(config.stateDirectory, `doctor-${randomUUID()}`);
      await privateDirectory(scratch);
      const store = new RuntimeNodeStore(join(scratch, "probe.sqlite"));
      store.close();
      checks.push({ name: "sqlite", status: "pass", message: "Disposable SQLite runtime store opened and closed successfully." });
    } catch {
      checks.push({ name: "sqlite", status: "fail", message: "SQLite preflight failed; check the installed framework version and local state permissions. No host catalog was opened." });
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
  try {
    for (const root of config.allowedRoots) if (!(await stat(root)).isDirectory()) throw new Error("root");
    checks.push({ name: "workspaces", status: "pass", message: "All configured workspace roots exist." });
  } catch { checks.push({ name: "workspaces", status: "fail", message: "At least one configured workspace root is missing or inaccessible." }); }
  try {
    const secret = await stat(join(config.stateDirectory, "shared-secret"));
    if (!secret.isFile() || secret.size < 32) throw new Error("secret");
    checks.push({ name: "enrollment", status: "pass", message: "A local fleet enrollment credential is present; the gateway verifies it during pairing." });
  } catch { checks.push({ name: "enrollment", status: "fail", message: "Initialize this host with the existing fleet credential using init --secret-file before starting it." }); }
  if (stateReady) {
    try { checks.push(...await probeCopilot(new CopilotClient(copilotClientOptions(config, environment)))); }
    catch { checks.push({ name: "copilot", status: "fail", message: "The pinned Copilot native package could not load; reinstall with optional dependencies enabled." }); }
  }
  checks.push({ name: "gateway-connectivity", status: "manual", message: "Verify that this host is online in the web UI after enrollment. GitHub authentication does not test the separate Iroh network path to the NAS." });
  checks.push({ name: "output-images", status: process.platform === "linux" ? "pass" : "manual", message: process.platform === "linux" ? "Secure local image-path reads are available." : "Windows image-path previews are unavailable; uploaded images use the separate blob path. Stock TUI attachment is disabled." });
  return { version: 1, ok: checks.every(check => check.status !== "fail"), checks };
}

export function parseLoginOptions(args: string[]): string[] {
  const result = ["login"];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--device-code" && !result.includes("--device-code")) result.push("--device-code");
    else if (args[i] === "--host" && !result.includes("--host")) {
      const value = args[++i];
      let url: URL;
      try { url = new URL(value ?? ""); } catch { throw new Error("Login host must be an HTTPS GitHub host URL"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) throw new Error("Login host must be an HTTPS GitHub host URL");
      result.push("--host", url.origin);
    } else throw new Error("Supported login options: --device-code and --host https://company.ghe.com");
  }
  return result;
}

export async function runManagedHost(config: HostConfig, signal: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) controller.abort();
  const settle = async (run: () => Promise<void>) => { try { await run(); } finally { controller.abort(); } };
  try {
    let ready!: () => void;
    const whenReady = new Promise<void>(resolve => { ready = resolve; });
    const control = settle(() => runHostControl(config, controller.signal, ready));
    const runtime = async () => {
      // A previous bootstrap file may contain a stale ticket. Start only after
      // this control process has persisted its current locator.
      await Promise.race([whenReady, control]);
      if (!controller.signal.aborted) await settle(() => runHost(config, controller.signal));
    };
    const results = await Promise.allSettled([
      control, runtime(),
    ]);
    if (!signal.aborted && results.some(result => result.status === "rejected")) throw new Error("Host stopped after a startup/runtime failure; run doctor before retrying");
  } finally { signal.removeEventListener("abort", stop); }
}

export async function main(args = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help") {
    console.log("leo-host init --secret-file <private-file>\nleo-host login [--device-code] [--host https://company.ghe.com]\nleo-host doctor [--json]\nleo-host start [--enroll]\nleo-host pairing\n\nCopilot uses corporate GitHub sign-in in its own managed home. Start stays in the foreground; Ctrl+C stops only this managed host. --enroll temporarily permits initial runtime/gateway enrollment until the next normal start.");
    return;
  }
  const config = hostConfig({ ...environment, LEO_HARNESS: "copilot" });
  if (command === "init") {
    if (args.length !== 3 || args[1] !== "--secret-file" || !args[2]) throw new Error("Use init --secret-file <private-file>");
    await prepareCopilotHome(config, environment);
    await importEnrollmentSecret(config.stateDirectory, args[2]);
    console.log("Enrollment credential imported. No host process or native session was started.");
  } else if (command === "doctor") {
    if (args.slice(1).some(arg => arg !== "--json")) throw new Error("Supported doctor option: --json");
    const report = await doctor(config, environment);
    console.log(args.includes("--json") ? JSON.stringify(report) : report.checks.map(check => `${check.status.toUpperCase()} ${check.name}: ${check.message}`).join("\n"));
    if (!report.ok) process.exitCode = 1;
  } else if (command === "login") {
    const loginArgs = parseLoginOptions(args.slice(1));
    await prepareCopilotHome(config, environment);
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(copilotExecutable(), loginArgs, { cwd: config.stateDirectory, env: copilotEnvironment(config.copilotHome, environment), stdio: "inherit", shell: false });
      child.once("error", () => reject(new Error("Could not start the pinned Copilot login command")));
      child.once("exit", code => resolve(code ?? 1));
    });
    process.exitCode = code;
  } else if (command === "start") {
    if (args.slice(1).some(arg => arg !== "--enroll")) throw new Error("Supported start option: --enroll");
    if (process.platform === "win32" && process.arch !== "x64") throw new Error("The pinned Windows transport requires x64 Node");
    const secret = await stat(join(config.stateDirectory, "shared-secret"));
    if (!secret.isFile() || secret.size < 32) throw new Error("Initialize the fleet enrollment credential before starting");
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    console.log(args.includes("--enroll") ? "Starting with enrollment open. After pairing, press Ctrl+C and start again without --enroll." : "Starting managed Copilot host. Press Ctrl+C to stop.");
    try { await runManagedHost({ ...config, enrollGateways: args.includes("--enroll"), enrollRuntimes: args.includes("--enroll") }, controller.signal); }
    finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  } else if (command === "pairing" && args.length === 1) {
    console.log(`Private pairing file: ${join(config.stateDirectory, "gateway-pairing.json")}\nTransfer it using an approved private channel. It contains an enrollment secret; do not paste it in chat or a URL.`);
  } else throw new Error("Unknown command; run leo-host help");
}
