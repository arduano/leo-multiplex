import type { RuntimeNodeDescriptor, SessionRecord } from "@arduano/agent-multiplex-protocol";
import { activityMatchesSession, type SessionActivity } from "../../../../packages/session-activity/src/contract.js";

export type AgentStatusKind = "working" | "input" | "error" | "finished" | "interrupted" | "ready" | "stopped" | "offline";
export type AgentFilter = "all" | "watched" | "needsInput" | "working" | "finished";
export interface AgentStatus {
  readonly kind: AgentStatusKind;
  readonly label: string;
  readonly description: string;
  readonly activity?: SessionActivity;
}

/** Catalog availability fences native observations. Idle is never proof of success. */
export function agentStatus(session: SessionRecord, stale: boolean, runtime?: RuntimeNodeDescriptor, observation?: SessionActivity): AgentStatus {
  const activity = observation && activityMatchesSession(observation, session) ? observation : undefined;
  if (stale || session.availability === "unavailable" || runtime && (runtime.presence !== "online" || runtime.reachability !== "reachable")) {
    return { kind: "offline", label: "Offline", description: "Host unavailable. Last known activity is preserved; current progress is unknown." };
  }
  if (session.availability !== "active" || session.runtimeStatus === "stopped") {
    return { kind: "stopped", label: "Stopped", description: "Stopped and resumable. Stopping does not mean the work finished." };
  }
  if (session.runtimeStatus === "waitingForInput") return { kind: "input", label: "Needs you", description: "Open this agent to answer its question or review an approval.", ...(activity?.kind === "input" ? { activity } : {}) };
  // Native failure/recovery can arrive before the catalog status catches up.
  // The observer replaces these records on accepted new work, never on send.
  if (activity?.kind === "error") return { kind: "error", label: activity.label ?? "Error", description: "Review the reported error before continuing.", activity };
  if (activity?.kind === "input") return { kind: "input", label: "Needs you", description: "Open this agent to review its pending request.", activity };
  if (activity?.kind === "interrupted") return { kind: "interrupted", label: "Interrupted", description: "The latest turn was interrupted; it did not finish successfully.", activity };
  if (activity?.kind === "working") return { kind: "working", label: activity.label === "Retrying" ? "Retrying" : "Working", description: "The agent is working on your request.", activity };
  if (session.runtimeStatus === "running") return { kind: "working", label: "Working", description: "The agent is working on your request." };
  if (session.runtimeStatus === "error") return { kind: "error", label: "Error", description: "Review the reported error before continuing." };
  if (activity?.kind === "completion") return { kind: "finished", label: "Finished", description: "The latest observed turn finished successfully. Open the conversation to review its result.", activity };
  return { kind: "ready", label: "Ready", description: "Ready for a message. No successful completion has been observed for the current turn." };
}

export function statusMatchesFilter(status: AgentStatus, filter: AgentFilter, watched: boolean): boolean {
  return filter === "all" || filter === "watched" && watched ||
    filter === "needsInput" && (status.kind === "input" || status.kind === "error" || status.kind === "interrupted") ||
    filter === "working" && status.kind === "working" || filter === "finished" && status.kind === "finished";
}
export function statusRank(status: AgentStatus, unseen: boolean): number {
  if (status.kind === "input" || status.kind === "error") return 0;
  if (status.kind === "working") return 1;
  if (unseen) return 2;
  return ({ finished: 3, interrupted: 3, ready: 4, stopped: 5, offline: 6 } as Partial<Record<AgentStatusKind, number>>)[status.kind] ?? 4;
}
export function activityTime(session: SessionRecord, status: AgentStatus): string {
  return status.activity?.occurredAt ?? session.lastActivityAt ?? session.createdAt;
}
export function relativeActivityTime(value: string, now: number): string {
  const milliseconds = now - Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "";
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
