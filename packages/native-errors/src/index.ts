import type { NativeEvent } from "@arduano/agent-multiplex-protocol";

export interface NativeFailure {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly guidance: string;
  readonly code?: string | undefined;
  readonly details?: string | undefined;
  readonly willRetry: boolean;
  readonly turnId?: string | undefined;
  readonly threadId?: string | undefined;
}

interface FailureContext {
  readonly id: string;
  readonly turnId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly willRetry?: boolean | undefined;
}

type FailureKind = "capacity" | "usage" | "budget" | "rate" | "context" | "auth" | "unknown";
const FIELD_BYTES = 16_384;

/** Only native error fields are classified; message text is never rewritten. */
export function codexFailure(error: unknown, context: FailureContext): NativeFailure {
  const native = record(error);
  const info = native?.codexErrorInfo;
  const variant = record(info);
  const variantKeys = variant ? Object.keys(variant) : [];
  const code = text(info) ?? (variantKeys.length === 1 ? text(variantKeys[0]) : undefined);
  const status = code && variant ? record(variant[code])?.httpStatusCode : undefined;
  const message = text(native?.message);
  const typedKind = code !== undefined ? kindFromCode(code, status) : "unknown";
  const kind = typedKind !== "unknown" ? typedKind
    : code === undefined || code === "other" || variant ? kindFromMessage(message) : "unknown";
  return failure("Codex", kind, message, code, text(native?.additionalDetails), context);
}

/** Shared by turn history and live notifications so completion replaces retry. */
export function codexFailureId(threadId: string | undefined, turnId: string | undefined, fallback: string): string {
  return turnId
    ? `codex:failure:${JSON.stringify([threadId ?? null, turnId])}`
    : `codex:failure:event:${fallback}`;
}

/** Copilot persists session.error events in its native history. */
export function copilotFailure(error: unknown, context: FailureContext): NativeFailure {
  const native = record(error);
  const code = text(native?.errorCode);
  const category = text(native?.errorType);
  const message = text(native?.message);
  const typed = code ?? category;
  const codeKind = typed !== undefined ? kindFromCode(typed, native?.statusCode) : "unknown";
  const kind = codeKind !== "unknown" ? codeKind
    : category !== undefined ? kindFromCode(category, native?.statusCode)
    : typed !== undefined ? "unknown" : kindFromMessage(message);
  return failure("Copilot", kind, message, code ?? category, undefined, context);
}

/** Ignore ordinary content even when it discusses a capacity or account error. */
export function failureFromEvent(event: NativeEvent): NativeFailure | null {
  const payload = record(event.payload.json);
  if (event.harness === "copilot") {
    if (event.nativeType !== "session.error") return null;
    return copilotFailure(payload?.data, {
      id: `copilot:${text(payload?.id) ?? `session.error:${event.runtimeEpoch}:${event.sequence}`}`,
      willRetry: record(payload?.data)?.willRetry === true,
    });
  }
  if (event.nativeType !== "error" && event.nativeType !== "turn/completed" && event.nativeType !== "turn/failed") return null;
  const turn = record(payload?.turn);
  if (event.nativeType === "turn/completed" && turn?.status !== "failed") return null;
  const turnId = text(turn?.id) ?? text(payload?.turnId);
  const threadId = text(payload?.threadId);
  return codexFailure(turn?.error ?? payload?.error ?? payload, {
    id: codexFailureId(threadId, turnId, `${event.runtimeEpoch}:${event.sequence}`),
    turnId,
    threadId,
    willRetry: event.nativeType === "error" && payload?.willRetry === true,
  });
}

function failure(
  harness: "Codex" | "Copilot",
  kind: FailureKind,
  message: string | undefined,
  code: string | undefined,
  details: string | undefined,
  context: FailureContext,
): NativeFailure {
  const descriptions: Record<FailureKind, readonly [string, string]> = {
    capacity: ["Model at capacity", "Wait for model capacity to recover, or choose another model before sending again."],
    usage: ["Usage limit reached", "Check your usage allowance and its reset time before sending again."],
    budget: ["Session budget reached", "Check the session budget before continuing, or start a new session."],
    rate: ["Rate limit reached", "Wait for the provider's rate limit to reset before sending again."],
    context: ["Context limit reached", "Start a new conversation or reduce the context before continuing."],
    auth: ["Authentication or access failed", "Check the host's provider sign-in and account access before continuing."],
    unknown: [`${harness} error`, "Review the error and the latest session state before deciding how to continue."],
  };
  const [title, guidance] = descriptions[kind];
  const willRetry = context.willRetry === true;
  return {
    id: text(context.id)!, title,
    message: message ?? `${harness} reported a failure without an error message.`,
    guidance: willRetry ? `${harness} is retrying automatically. Wait for the next update before sending again.` : guidance,
    code, details, willRetry,
    turnId: text(context.turnId), threadId: text(context.threadId),
  };
}

function kindFromCode(code: string, status?: unknown): FailureKind {
  switch (code.replaceAll(/[^a-z0-9]/gi, "").toLowerCase()) {
    case "serveroverloaded": case "overloaded": case "capacity": case "modelcapacity": return "capacity";
    case "usagelimitexceeded": case "quota": case "quotaexceeded": case "billingnotconfigured": return "usage";
    case "sessionbudgetexceeded": case "sessionquotaexceeded": return "budget";
    case "ratelimitexceeded": case "ratelimit": case "ratelimited": case "userweeklyratelimited":
    case "userglobalratelimited": case "usermodelratelimited": case "integrationratelimited": return "rate";
    case "contextwindowexceeded": case "contextlimit": case "contextlengthexceeded": return "context";
    case "unauthorized": case "authentication": case "authorization": case "authenticationerror":
    case "permissiondenied": case "invalidapikey": return "auth";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  return "unknown";
}

function kindFromMessage(message: string | undefined): FailureKind {
  if (!message) return "unknown";
  if (/\b(?:session|turn) budget (?:is )?(?:exceeded|exhausted|reached)\b|\bbudget limit (?:is )?(?:exceeded|reached)\b/i.test(message)) return "budget";
  if (/\b(?:usage|quota|credit|credits|spending) (?:limit |allowance )?(?:is |was |has been )?(?:exceeded|exhausted|reached|depleted)\b|\b(?:hit|reached|exceeded) (?:your |the )?(?:usage limit|quota)\b|\binsufficient (?:quota|credits)\b/i.test(message)) return "usage";
  if (/\brate[ -]?limit(?:ed| exceeded| reached)?\b|\btoo many requests\b/i.test(message)) return "rate";
  if (/\b(?:context (?:window|length|limit)|maximum context length) (?:is |was )?(?:exceeded|full|reached)\b|\bcontext length exceeds\b/i.test(message)) return "context";
  if (/\b(?:at capacity|capacity (?:limit )?(?:reached|exceeded)|overloaded)\b/i.test(message)) return "capacity";
  if (/\b(?:unauthorized|authentication (?:failed|required)|invalid api key|incorrect api key|not authenticated|access denied)\b/i.test(message)) return "auth";
  return "unknown";
}

/** Bound display fields by UTF-8 bytes without splitting a Unicode character. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let bytes = 0;
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > FIELD_BYTES) break;
    length += character.length;
  }
  return length === value.length ? value : value.slice(0, length);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
