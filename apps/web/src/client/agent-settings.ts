import type {
  Harness,
  HarnessSessionSettings,
  NativeModel,
  RuntimeNodeDescriptor,
} from "@arduano/agent-multiplex-protocol";

export function supportsCopilotPermissions(runtime: RuntimeNodeDescriptor | undefined): boolean {
  return runtime?.harnesses.find(entry => entry.harness === "copilot")?.capabilities.some(capability => capability.name === "permissions.mode" && capability.version === "v1") === true;
}

export function copilotPermissionLabel(settings: HarnessSessionSettings | undefined): string {
  const permission = settings?.copilotPermissions;
  return permission?.mode === "assisted" ? "Assisted review" : permission ? `YOLO ${permission.mode === "allow-all" ? "on" : "off"}` : "YOLO";
}

/** Use the harness catalog's declared default without promoting hidden legacy entries. */
export function preferredModel(models: readonly NativeModel[]): NativeModel | undefined {
  return models.find((candidate) => nativeBoolean(candidate.native, "isDefault") === true)
    ?? models.find((candidate) => nativeBoolean(candidate.native, "hidden") !== true)
    ?? models[0];
}

export function appliedSettingsSummary(
  harness: Harness,
  settings: HarnessSessionSettings | undefined,
  models: readonly Pick<NativeModel, "id" | "name">[],
): string {
  const model = settings?.model
    ? models.find((candidate) => candidate.id === settings.model)
    : undefined;
  const modelLabel = model?.name ?? model?.id ?? settings?.model ?? "Model unavailable";
  const modeLabel = settings?.mode ? settingLabel(settings.mode) : "Mode unavailable";
  if (harness !== "codex") return `${modelLabel} · ${modeLabel}${settings?.copilotPermissions ? ` · ${copilotPermissionLabel(settings)}` : ""}`;
  const effortLabel = typeof settings?.effort === "string"
    ? settingLabel(settings.effort)
    : settings?.effort === null
      ? "Harness effort"
      : "Effort unavailable";
  return `${modelLabel} · ${modeLabel} · ${effortLabel}`;
}

function nativeBoolean(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function settingLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[./_-]+/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}
