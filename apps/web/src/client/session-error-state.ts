import type { NativeEvent } from "@arduano/agent-multiplex-protocol";
import { codexFailure, failureFromEvent, type NativeFailure } from "./native-errors.js";

export const unavailableFailure: NativeFailure = {
  id: "native-status-error",
  title: "Codex stopped with an error",
  message: "Codex reports an error, but this history API does not include the earlier turn's error message.",
  guidance: "Check the error in Terminal before continuing. A usage or capacity limit may still apply.",
  code: "detailsUnavailable",
  willRetry: false,
};

/** One observation per binding; live updates never traverse loaded history. */
export class SessionErrorState {
  private failure: NativeFailure | null = null;
  private activeTurn: string | undefined;
  private revision = 0;
  private sequence = -1;
  private readonly listeners = new Set<() => void>();
  readonly snapshot = (): NativeFailure | null => this.failure;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get generation(): number { return this.revision; }

  observeStatus(status: unknown, generation: number): void {
    if (generation !== this.revision) return;
    const type = object(status)?.type;
    if (type === "systemError" && !this.failure) {
      this.revision += 1;
      this.set(unavailableFailure);
    }
    // A current native active status also repairs a missed turn/started while
    // this binding was not selected. Idle alone does not prove error recovery.
    if (type === "active" && this.failure && !this.failure.willRetry) {
      this.activeTurn = undefined;
      this.revision += 1;
      this.set(null);
    }
  }

  observe(event: NativeEvent, vendorSessionId: string): void {
    if (event.sequence <= this.sequence) return;
    this.sequence = event.sequence;
    const payload = object(event.payload.json);
    // Descendant notifications share the root's stream but must not overwrite
    // its failure or clear a root failure when a child completes successfully.
    if (event.harness === "codex" && typeof payload?.threadId === "string" && payload.threadId !== vendorSessionId) return;
    const turn = object(payload?.turn);
    if (event.nativeType === "turn/started") {
      this.activeTurn = typeof turn?.id === "string" ? turn.id : undefined;
      this.revision += 1;
      // Native acceptance of a new turn supersedes the previous turn's banner.
      // Keep its transcript notice, and keep same-turn retry errors until work
      // actually progresses. Command acknowledgments never clear this state.
      if (this.activeTurn && this.activeTurn !== this.failure?.turnId) this.set(null);
      return;
    }
    if (event.nativeType === "turn/completed" && this.activeTurn && turn?.id !== this.activeTurn) return;
    let failure = failureFromEvent(event);
    if (failure) {
      if (this.activeTurn && failure.turnId && failure.turnId !== this.activeTurn) return;
      if (event.harness === "codex" && event.nativeType !== "error" &&
        failure.id === this.failure?.id && (turn?.error ?? payload?.error) == null) {
        failure = codexFailure({ message: this.failure.message, codexErrorInfo: this.failure.code,
          additionalDetails: this.failure.details }, { ...failure, willRetry: false });
      }
      this.revision += 1;
      if (event.nativeType === "turn/completed") this.activeTurn = undefined;
      this.set(failure);
      return;
    }
    if (event.harness === "codex" && this.failure &&
      typeof payload?.turnId === "string" && payload.threadId === vendorSessionId &&
      (!this.activeTurn || payload.turnId === this.activeTurn) &&
      (this.failure.willRetry || !this.failure.turnId || payload.turnId !== this.failure.turnId) &&
      (event.nativeType === "item/agentMessage/delta" ||
        event.nativeType === "item/plan/delta" ||
        event.nativeType === "item/reasoning/textDelta" ||
        event.nativeType === "item/reasoning/summaryTextDelta") &&
      typeof payload.delta === "string" && payload.delta.length > 0) {
      // Output is positive recovery evidence even if turn/started was missed,
      // or the provider recovered while retrying the same turn.
      this.activeTurn = payload.turnId;
      this.revision += 1;
      this.set(null);
      return;
    }
    if (event.nativeType === "turn/completed" && turn?.status === "completed" ||
      event.harness === "copilot" && event.nativeType === "assistant.message") {
      this.revision += 1;
      this.activeTurn = undefined;
      this.set(null);
      return;
    }
    if (event.nativeType === "thread/status/changed") {
      this.revision += 1;
      this.observeStatus(payload?.status, this.revision);
    }
  }
  private set(failure: NativeFailure | null): void {
    if (this.failure === failure) return;
    this.failure = failure;
    for (const listener of this.listeners) listener();
  }
}

// Navigation retains the last observed error in this tab. No native messages
// are written to browser storage, and inactive bindings have bounded retention.
const states = new Map<string, SessionErrorState>();
export function sessionErrorState(binding: string): SessionErrorState {
  const state = states.get(binding) ?? new SessionErrorState();
  states.delete(binding);
  states.set(binding, state);
  while (states.size > 128) states.delete(states.keys().next().value!);
  return state;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
