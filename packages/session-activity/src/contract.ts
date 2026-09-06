import type { SessionRecord } from "@arduano/agent-multiplex-protocol";

export const SESSION_ACTIVITY_LIMIT = 500;
export type SessionActivityKind = "working" | "completion" | "input" | "error" | "interrupted";
export type SessionActivityBinding = Pick<SessionRecord,
  "sessionId" | "runtimeNodeId" | "adapterScopeId" | "vendorSessionId" | "bindingRevision" | "runtimeEpoch" | "harness">;

/** Latest accepted observation, not catalog authority or native history. */
export interface SessionActivity extends SessionActivityBinding {
  readonly eventId: string;
  readonly kind: SessionActivityKind;
  readonly occurredAt: string;
  /** Controlled status copy only; never native message text or paths. */
  readonly label?: string;
}
export interface SessionActivityResponse { sessions: SessionActivity[] }

export function activityMatchesSession(activity: SessionActivityBinding, session: SessionActivityBinding): boolean {
  return activity.sessionId === session.sessionId && activity.runtimeNodeId === session.runtimeNodeId &&
    activity.adapterScopeId === session.adapterScopeId && activity.vendorSessionId === session.vendorSessionId &&
    activity.bindingRevision === session.bindingRevision && activity.runtimeEpoch === session.runtimeEpoch && activity.harness === session.harness;
}
