import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { launchProfileDescriptorSchema, type Harness, type JsonObject, type LaunchProfileDescriptor } from "@arduano/agent-multiplex-protocol";
import { jsonSchemaSha256, type LaunchPreparationContext, type LaunchResumeContext, type RuntimeLaunchProvider, type RuntimePreparedLaunch, type RuntimePreparedResume, type RuntimeAgentBackend } from "@arduano/agent-multiplex-runtime-node-core";

const requestSchema: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object", additionalProperties: false, required: ["cwd"],
  properties: { cwd: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, mode: { enum: ["interactive", "plan", "autopilot"] } },
};

/** Separate profile identity keeps persisted Codex launch fences unchanged. */
export class LeoCopilotLaunchProvider implements RuntimeLaunchProvider {
  readonly requestSchema = requestSchema;
  readonly descriptor: LaunchProfileDescriptor;

  constructor(private readonly backend: RuntimeAgentBackend) {
    if (backend.adapter.harness !== "copilot") throw new Error("Copilot workspace requires a Copilot backend");
    this.descriptor = launchProfileDescriptorSchema.parse({
      providerId: "leo.local", profileId: "copilot-workspace", contractVersion: 1,
      requestSchemaHash: jsonSchemaSha256(requestSchema), implementationVersion: "1.0.0",
      harnesses: ["copilot"], available: true,
      capabilities: [{ name: "workspace.existing-directory", version: "v1", experimental: false }, { name: "isolation.none", version: "v1", experimental: false }],
    });
  }

  validateInput(input: JsonObject, harness: Harness): JsonObject {
    if (harness !== "copilot") throw new Error("Copilot workspace supports Copilot");
    if (Object.keys(input).some(key => !["cwd", "model", "mode"].includes(key))) throw new Error("Unsupported Copilot workspace option");
    if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw new Error("The working directory must be absolute");
    if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim())) throw new Error("Invalid model");
    if (input.mode !== undefined && !["interactive", "plan", "autopilot"].includes(input.mode as string)) throw new Error("Invalid Copilot mode");
    return { ...input };
  }

  async prepare(context: LaunchPreparationContext): Promise<RuntimePreparedLaunch> {
    const input = this.validateInput(context.request.input, context.request.harness);
    const cwd = input.cwd as string;
    if (!(await stat(cwd)).isDirectory()) throw new Error("The working directory must be an existing directory");
    return { backendId: this.backend.backendId, spawnOptions: {
      harness: "copilot", cwd,
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      mode: input.mode as "interactive" | "plan" | "autopilot" | undefined ?? "interactive",
    } };
  }

  async prepareResume(context: LaunchResumeContext): Promise<RuntimePreparedResume> {
    if (context.defaults.harness !== "copilot") throw new Error("Copilot resume requires a Copilot binding");
    const cwd = context.defaults.cwd;
    if (!cwd || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("The working directory must still exist");
    return { backendId: context.prepared.backendId, resumeOptions: { ...context.defaults } };
  }

  listModels() { return this.backend.adapter.listModels(); }
  async recoverPreparation() { return { state: "retryPreparation" } as const; }
  async compensate(): Promise<void> {}
  async stop(): Promise<void> {}
  async release(): Promise<void> {}
}
