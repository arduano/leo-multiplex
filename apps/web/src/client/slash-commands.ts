import type { Harness, HarnessCommand, NativeModel } from "@arduano/agent-multiplex-protocol";

export const slashCommands = [
  { name: "plan", description: "Plan before making changes", usage: "/plan [on|off]" },
  { name: "model", description: "Choose a model", usage: "/model [model ID]" },
  { name: "effort", description: "Change reasoning effort", usage: "/effort [level]", codexOnly: true },
  { name: "mode", description: "Choose how the agent works", usage: "/mode [mode]" },
  { name: "default", description: "Return to normal agent mode", usage: "/default" },
  { name: "interrupt", description: "Interrupt the current turn", usage: "/interrupt" },
  { name: "new", description: "Open a new agent", usage: "/new" },
  { name: "status", description: "Show session and connection details", usage: "/status" },
  { name: "terminal", description: "Open this agent’s terminal", usage: "/terminal" },
  { name: "help", description: "Show available commands", usage: "/help" },
] as const;
export type SlashCommandName = typeof slashCommands[number]["name"];
export type SettingsSection = "model" | "effort" | "mode";
export type SlashResult =
  | { kind: "message"; text: string }
  | { kind: "error"; message: string }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "local"; action: "new" | "status" | "terminal" | "help" }
  | { kind: "command"; request: HarnessCommand; success: string };

/** Only the first standalone slash token is a command. Paths and multiline prose stay messages. */
export function slashToken(input: string) {
  const text = input.trimStart();
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  const first = /^\/([a-z][a-z0-9_-]*)(?=\s|$)/i.exec(text);
  return first ? { name: first[1]!.toLowerCase(), argument: text.slice(first[0].length).trim() } : null;
}
export function slashSuggestions(input: string, harness: Harness) {
  const text = input.trimStart();
  if (!/^\/[a-z]*$/i.test(text)) return [];
  return slashCommands.filter(item => (!("codexOnly" in item) || harness === "codex") && item.name.startsWith(text.slice(1).toLowerCase()));
}
export function reasoningOptions(model: NativeModel | undefined): readonly { value: string; description: string }[] {
  const native = object(model?.native);
  if (!Array.isArray(native?.supportedReasoningEfforts)) return [];
  const options = new Map<string, { value: string; description: string }>();
  for (const item of native.supportedReasoningEfforts) {
    const entry = object(item);
    if (typeof entry?.reasoningEffort === "string" && entry.reasoningEffort) options.set(entry.reasoningEffort, { value: entry.reasoningEffort, description: typeof entry.description === "string" ? entry.description : "" });
  }
  return [...options.values()];
}
export function resolveSlash(input: string, context: { harness: Harness; models: readonly NativeModel[]; model?: string | undefined; running: boolean }): SlashResult {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("//")) return { kind: "message", text: input.slice(0, input.length - trimmed.length) + trimmed.slice(1) };
  const token = slashToken(input);
  if (!token) return trimmed === "/" ? { kind: "local", action: "help" } : { kind: "message", text: input };
  const { name, argument } = token;
  const definition = slashCommands.find(item => item.name === name);
  if (!definition) return { kind: "error", message: `/${name} isn’t available here. Use /help for commands, or //${name} to send it as text.` };
  if ("codexOnly" in definition && context.harness !== "codex") return { kind: "error", message: `/${name} is available for Codex sessions.` };
  if (["new", "status", "terminal", "help"].includes(name)) return argument ? usage(definition.usage) : { kind: "local", action: name as "new" | "status" | "terminal" | "help" };
  if (name === "interrupt") {
    if (argument) return usage(definition.usage);
    if (!context.running) return { kind: "error", message: "There is no running turn to interrupt." };
    return { kind: "command", request: context.harness === "codex" ? { harness: "codex", command: { type: "interrupt" } } : { harness: "copilot", command: { type: "interrupt" } }, success: "Interrupt requested" };
  }
  if (name === "model") {
    if (!argument) return { kind: "settings", section: "model" };
    const exact = context.models.find(model => model.id === argument);
    const matches = exact ? [exact] : context.models.filter(model => model.name?.toLowerCase() === argument.toLowerCase());
    if (matches.length !== 1) return { kind: "error", message: "Choose an exact model ID or unique name from /model." };
    const model = matches[0]!;
    return { kind: "command", request: context.harness === "codex" ? { harness: "codex", command: { type: "setModel", model: model.id } } : { harness: "copilot", command: { type: "setModel", model: model.id } }, success: `Next-turn model: ${model.name ?? model.id}` };
  }
  if (name === "effort") {
    if (!argument) return { kind: "settings", section: "effort" };
    const choices = reasoningOptions(context.models.find(model => model.id === context.model));
    if (!choices.some(choice => choice.value === argument)) return { kind: "error", message: choices.length ? `Choose a supported reasoning level: ${choices.map(choice => choice.value).join(", ")}.` : "Reasoning options are unavailable for the applied model. Open /model to check its catalog." };
    return { kind: "command", request: { harness: "codex", command: { type: "setEffort", effort: argument } }, success: `Next-turn reasoning: ${argument}` };
  }
  if (name === "mode" && !argument) return { kind: "settings", section: "mode" };
  const normal = context.harness === "codex" ? "default" : "interactive";
  let mode = argument;
  if (name === "plan") {
    if (!["", "on", "off"].includes(argument)) return usage("/plan [on|off] — change mode, then send your message separately");
    mode = argument === "off" ? normal : "plan";
  } else if (name === "default") { if (argument) return usage(definition.usage); mode = normal; }
  const modes = context.harness === "codex" ? ["default", "plan"] : ["interactive", "plan", "autopilot"];
  if (!modes.includes(mode)) return { kind: "error", message: `Choose a mode: ${modes.join(", ")}.` };
  return { kind: "command", request: context.harness === "codex" ? { harness: "codex", command: { type: "setMode", mode } } : { harness: "copilot", command: { type: "setMode", mode: mode as "interactive" | "plan" | "autopilot" } }, success: `Next-turn mode: ${mode === "default" ? "Agent" : mode}` };
}
function usage(usage: string): SlashResult { return { kind: "error", message: `Use ${usage}.` }; }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
