import { z } from "zod";

// Private Leo work-laptop extension. Never added to the Agent Multiplex router.
export const WORK_COMMAND_PROTOCOL = { applicationId: "leo-work-laptop-commands", contractVersion: "1" } as const;
export const MAX_COMMAND_BYTES = 16_384;
export const MAX_OUTPUT_BYTES = 128 * 1_024;
export const MAX_TIMEOUT_MS = 300_000;
const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => !value.includes("\0"));
export const workHostPairingSchema = z.object({
  sourceId: text(100), name: text(100), platform: z.enum(["windows", "wsl"]),
  endpointId: z.string().regex(/^[a-z2-7]{52}$/),
  locator: z.object({ kind: z.literal("ticket"), ticket: text(16_384) }).strict(),
}).strict();
export type WorkHostPairing = z.infer<typeof workHostPairingSchema>;
export const workHostTargetSchema = workHostPairingSchema.pick({ sourceId: true, endpointId: true });
export type WorkHostTarget = z.infer<typeof workHostTargetSchema>;
export const workCommandRequestSchema = z.object({
  operationId: z.string().uuid(), cwd: text(4_096),
  command: text(MAX_COMMAND_BYTES).refine(value => new TextEncoder().encode(value).byteLength <= MAX_COMMAND_BYTES, "Command exceeds the byte limit"),
  timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS),
}).strict();
export type WorkCommandRequest = z.infer<typeof workCommandRequestSchema>;
export const workCommandIdSchema = z.object({ operationId: z.string().uuid() }).strict();
export const workCommandSubmitSchema = z.object({ target: workHostTargetSchema, request: workCommandRequestSchema }).strict();
export const workCommandLookupSchema = z.object({ target: workHostTargetSchema, operationId: z.string().uuid() }).strict();
export type WorkCommandSubmit = z.infer<typeof workCommandSubmitSchema>;
export type WorkCommandLookup = z.infer<typeof workCommandLookupSchema>;
export const workCommandRecordSchema = workCommandRequestSchema.extend({
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["running", "completed", "timedOut", "cancelled", "failed", "outcomeUnknown"]),
  stdout: z.string().max(MAX_OUTPUT_BYTES), stderr: z.string().max(MAX_OUTPUT_BYTES),
  truncated: z.boolean(), exitCode: z.number().int().nullable(), signal: z.string().max(64).nullable(),
  createdAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
}).refine(record => new TextEncoder().encode(record.stdout).byteLength + new TextEncoder().encode(record.stderr).byteLength <= MAX_OUTPUT_BYTES, "Combined output exceeds the byte limit");
export type WorkCommandRecord = z.infer<typeof workCommandRecordSchema>;
export interface WorkCommandExecutor {
  submit(request: WorkCommandRequest): Promise<WorkCommandRecord>;
  get(operationId: string): Promise<WorkCommandRecord | null>;
  cancel(operationId: string): Promise<WorkCommandRecord | null>;
  close(): Promise<void>;
}
export interface WorkHostDescriptor extends WorkHostTarget {
  name: string;
  platform: "windows" | "wsl";
  available: boolean;
}
export interface WorkCommandsPort {
  hosts(): Promise<WorkHostDescriptor[]>;
  submit(input: WorkCommandSubmit): Promise<WorkCommandRecord>;
  get(input: WorkCommandLookup): Promise<WorkCommandRecord | null>;
  cancel(input: WorkCommandLookup): Promise<WorkCommandRecord | null>;
}

export function validateWorkHostPairings(value: unknown, sources: readonly { sourceId: string; endpointId: string }[] = []): WorkHostPairing[] {
  const hosts = z.array(workHostPairingSchema).max(16).parse(value ?? []);
  const sourceIds = new Set<string>(); const endpointIds = new Set<string>();
  for (const host of hosts) {
    if (sourceIds.has(host.sourceId) || endpointIds.has(host.endpointId) || sources.some(source => source.endpointId === host.endpointId)) {
      throw new Error("PAIRING_CONFLICT");
    }
    // A recovery descriptor must belong to a configured host, never invent a new unrelated source.
    if (sources.length > 0 && !sources.some(source => source.sourceId === host.sourceId)) throw new Error("PAIRING_CONFLICT");
    sourceIds.add(host.sourceId); endpointIds.add(host.endpointId);
  }
  return hosts;
}
