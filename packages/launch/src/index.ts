import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { launchProfileDescriptorSchema, type Harness, type JsonObject, type LaunchProfileDescriptor } from "@arduano/agent-multiplex-protocol";
import { jsonSchemaSha256, type LaunchPreparationContext, type LaunchResumeContext, type RuntimeLaunchProvider, type RuntimePreparedLaunch, type RuntimePreparedResume, type RuntimeAgentBackend } from "@arduano/agent-multiplex-runtime-node-core";

export const LEO_PROVIDER_ID = "leo.local";
export const LEO_PROFILE_ID = "workspace";
const requestSchema: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object", additionalProperties: false, required: ["cwd"],
  properties: { cwd: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, effort: { type: "string", minLength: 1 }, mode: { enum: ["default", "plan"] } },
};

export class LeoWorkspaceLaunchProvider implements RuntimeLaunchProvider {
  public readonly requestSchema = requestSchema;
  public readonly descriptor: LaunchProfileDescriptor;

  public constructor(private readonly backend: RuntimeAgentBackend, private readonly defaults: { model?: string; effort?: string } = {}) {
    if (backend.adapter.harness !== "codex") throw new Error("Leo workspace requires a Codex backend");
    this.descriptor = launchProfileDescriptorSchema.parse({
      providerId: LEO_PROVIDER_ID, profileId: LEO_PROFILE_ID, contractVersion: 1,
      requestSchemaHash: jsonSchemaSha256(requestSchema), implementationVersion: "1.0.0",
      harnesses: ["codex"], available: true,
      capabilities: [{ name: "workspace.existing-directory", version: "v1", experimental: false }, { name: "isolation.none", version: "v1", experimental: false }],
    });
  }

  public validateInput(input: JsonObject, harness: Harness): JsonObject {
    if (harness !== "codex") throw new Error("Leo workspace supports Codex");
    if (Object.keys(input).some((key) => !["cwd", "model", "effort", "mode"].includes(key))) throw new Error("Unsupported Leo workspace option");
    if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw new Error("The working directory must be absolute");
    for (const field of ["model", "effort"] as const) {
      if (input[field] !== undefined && (typeof input[field] !== "string" || !input[field])) throw new Error(`Invalid ${field}`);
    }
    if (input.mode !== undefined && input.mode !== "default" && input.mode !== "plan") throw new Error("Invalid collaboration mode");
    if (input.mode === "plan" && !input.model && !this.defaults.model) throw new Error("Plan mode requires a selected model");
    return { ...input };
  }

  public async prepare(context: LaunchPreparationContext): Promise<RuntimePreparedLaunch> {
    const input = this.validateInput(context.request.input, context.request.harness);
    const cwd = input.cwd as string;
    if (!(await stat(cwd)).isDirectory()) throw new Error("The working directory must be an existing directory");
    return { backendId: this.backend.backendId, spawnOptions: {
      harness: "codex", cwd, approvalPolicy: "never", sandbox: "danger-full-access",
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.effort === "string" ? { effort: input.effort } : {}),
      ...(input.mode === "plan" ? { collaborationMode: {
        mode: "plan", settings: {
          model: typeof input.model === "string" ? input.model : this.defaults.model!,
          reasoning_effort: typeof input.effort === "string" ? input.effort : this.defaults.effort ?? null,
          developer_instructions: null,
        },
      } } : {}),
    } };
  }

  public async prepareResume(context: LaunchResumeContext): Promise<RuntimePreparedResume> {
    const cwd = context.defaults.cwd;
    if (!cwd || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("The working directory must still exist");
    return { backendId: context.prepared.backendId, resumeOptions: {
      ...context.defaults, harness: "codex", approvalPolicy: "never", sandbox: "danger-full-access",
    } };
  }

  public listModels() { return this.backend.adapter.listModels(); }
  public async recoverPreparation() { return { state: "retryPreparation" } as const; }
  public async compensate(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async release(): Promise<void> {}
}
