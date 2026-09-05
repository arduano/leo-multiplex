import * as Popover from "@radix-ui/react-popover";
import * as Tabs from "@radix-ui/react-tabs";
import type { NativeModel, SessionRecord } from "@arduano/agent-multiplex-protocol";
import { Check, ChevronDown, X } from "lucide-react";
import { useState } from "react";

import { appliedSettingsSummary } from "./agent-settings.js";
import { Button, IconButton, Input, classes } from "./ui.js";

type SettingsSection = "model" | "effort" | "mode";

interface ModelPickerProps {
  readonly session: SessionRecord;
  readonly models: readonly NativeModel[];
  readonly loading: boolean;
  readonly loadError: boolean;
  readonly onRetryModels: () => void;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly section: SettingsSection;
  readonly onSectionChange: (section: SettingsSection) => void;
  readonly onModel: (model: string) => void;
  readonly onEffort: (effort: string) => void;
  readonly onMode: (mode: string) => void;
  readonly status: string;
}

/** Settings only become current when the host reports the applied native value. */
export function ModelPicker({
  session,
  models,
  loading,
  loadError,
  onRetryModels,
  disabled,
  open,
  onOpenChange,
  section,
  onSectionChange,
  onModel,
  onEffort,
  onMode,
  status,
}: ModelPickerProps) {
  const [search, setSearch] = useState("");
  const settings = session.harnessSettings;
  const currentModel = models.find((model) => model.id === settings?.model);
  const modelName = currentModel?.name ?? settings?.model ?? "Choose model";
  const availableModels = models.filter((model) =>
    model.id === settings?.model || nativeRecord(model.native)?.hidden !== true,
  );
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const matchingModels = availableModels.filter((model) =>
    !normalizedSearch || `${model.id} ${model.name ?? ""} ${model.description ?? ""}`
      .toLocaleLowerCase().includes(normalizedSearch),
  );
  const nativeModel = nativeRecord(currentModel?.native);
  const efforts = reasoningChoices(nativeModel?.supportedReasoningEfforts);
  const defaultEffort = typeof nativeModel?.defaultReasoningEffort === "string"
    ? nativeModel.defaultReasoningEffort
    : undefined;
  const currentEffort = typeof settings?.effort === "string" ? settings.effort : undefined;
  const modes = session.harness === "codex"
    ? [
      { id: "default", name: "Agent", description: "Work on the task and make changes." },
      { id: "plan", name: "Plan", description: "Plan before making changes." },
    ]
    : [
      { id: "interactive", name: "Interactive", description: "Work with you one step at a time." },
      { id: "plan", name: "Plan", description: "Plan before making changes." },
      { id: "autopilot", name: "Autopilot", description: "Continue working autonomously." },
    ];

  return (
    <Popover.Root open={open} onOpenChange={(value) => {
      if (!value) setSearch("");
      onOpenChange(value);
    }}>
      <Popover.Trigger asChild>
        <Button
          tone="ghost"
          className="min-w-0 max-w-56 gap-1.5 px-2 text-xs [@media(max-width:480px)]:max-w-[40vw]"
          aria-label={`Agent settings: ${modelName}`}
          title={`Agent settings: ${modelName}`}
          onClick={() => onSectionChange("model")}
          data-testid="agent-settings-button"
        >
          <span className="truncate">{modelName}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Agent settings"
          className="z-50 flex max-h-[min(560px,var(--radix-popover-content-available-height),calc(100dvh-24px))] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] outline-none"
          data-testid="agent-settings-popover"
        >
          <header className="flex shrink-0 items-start gap-2 px-3 py-2">
            <div className="min-w-0 flex-1 py-1">
              <h2 className="text-sm font-semibold">Agent settings</h2>
              <p
                className="mt-1 truncate text-xs text-[var(--text-secondary)]"
                title={appliedSettingsSummary(session.harness, settings, models)}
                data-testid="applied-settings-summary"
              >
                {appliedSettingsSummary(session.harness, settings, models)}
              </p>
            </div>
            <Popover.Close asChild>
              <IconButton icon={X} label="Close agent settings" tone="ghost" className="size-9 shrink-0" />
            </Popover.Close>
          </header>
          <Tabs.Root
            value={session.harness !== "codex" && section === "effort" ? "model" : section}
            onValueChange={(value) => onSectionChange(value as SettingsSection)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Tabs.List className="flex shrink-0 gap-1 border-b border-[var(--border-subtle)] px-3" aria-label="Agent settings sections">
              <SettingsTab value="model">Model</SettingsTab>
              {session.harness === "codex" ? <SettingsTab value="effort">Reasoning</SettingsTab> : null}
              <SettingsTab value="mode">Mode</SettingsTab>
            </Tabs.List>
            <Tabs.Content value="model" className="min-h-0 overflow-y-auto overscroll-contain p-2 outline-none">
              {availableModels.length > 7 ? (
                <Input
                  aria-label="Search models"
                  placeholder="Search models"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="mb-2 min-h-11"
                />
              ) : null}
              {loading ? <p className="p-2 text-sm text-[var(--text-secondary)]" role="status">Loading models…</p> : null}
              {loadError ? (
                <div className="p-2 text-sm text-[var(--text-secondary)]">
                  <p role="alert">Couldn’t load the model list.</p>
                  <Button className="mt-2" onClick={onRetryModels}>Try again</Button>
                </div>
              ) : null}
              {!settings?.model ? (
                <p className="px-2 py-2 text-xs leading-5 text-[var(--text-secondary)]">The host hasn’t reported the current model yet.</p>
              ) : !currentModel ? (
                <p className="break-words px-2 py-2 text-xs leading-5 text-[var(--text-secondary)]">
                  Current: {settings.model}. This model isn’t in the available list.
                </p>
              ) : null}
              <div data-testid="model-select" aria-label="Models">
                {matchingModels.map((model) => (
                  <SettingOption
                    key={model.id}
                    id={`model-option-${model.id}`}
                    label={model.name ?? model.id}
                    description={model.description}
                    detail={model.name && model.name !== model.id ? model.id : undefined}
                    current={model.id === settings?.model}
                    defaultChoice={nativeRecord(model.native)?.isDefault === true}
                    disabled={disabled || loading || loadError}
                    onClick={() => onModel(model.id)}
                  />
                ))}
              </div>
              {!loading && !loadError && !matchingModels.length ? (
                <p className="p-2 text-sm text-[var(--text-secondary)]">{normalizedSearch ? "No models match your search." : "No models are available from this host."}</p>
              ) : null}
            </Tabs.Content>
            {session.harness === "codex" ? (
              <Tabs.Content value="effort" className="min-h-0 overflow-y-auto overscroll-contain p-2 outline-none">
                <div className="px-2 py-2 text-xs leading-5 text-[var(--text-secondary)]">
                  <p className="break-words">Reasoning for {currentModel?.name ?? settings?.model ?? "the current model"}.</p>
                  <p>Current: {currentEffort ? settingLabel(currentEffort) : settings?.effort === null ? "Harness default" : "Not reported"}.</p>
                  {defaultEffort ? <p>The model default is {settingLabel(defaultEffort).toLowerCase()}.</p> : null}
                  {currentEffort && efforts?.length && !efforts.some(effort => effort.id === currentEffort) ? <p className="mt-1 text-[var(--status-waiting)]" role="status">{settingLabel(currentEffort)} isn’t listed for this model. Choose a supported level before your next message.</p> : null}
                </div>
                {loading ? <p className="p-2 text-sm text-[var(--text-secondary)]" role="status">Loading reasoning options…</p> : loadError ? (
                  <div className="p-2 text-sm text-[var(--text-secondary)]">
                    <p role="alert">Couldn’t load reasoning options.</p>
                    <Button className="mt-2" onClick={onRetryModels}>Try again</Button>
                  </div>
                ) : efforts === undefined ? (
                  <p className="px-2 pb-2 text-sm leading-6 text-[var(--text-secondary)]">The host hasn’t reported supported reasoning options for this model.{!currentModel ? " Choose a listed model to see its options." : ""}</p>
                ) : !efforts.length ? (
                  <p className="px-2 pb-2 text-sm leading-6 text-[var(--text-secondary)]">This model doesn’t offer a reasoning setting.</p>
                ) : (
                  <div data-testid="effort-select" aria-label="Reasoning effort">
                    {efforts.map((effort) => (
                      <SettingOption
                        key={effort.id}
                        id={`effort-option-${effort.id}`}
                        label={settingLabel(effort.id)}
                        description={effort.description}
                        current={effort.id === currentEffort}
                        defaultChoice={effort.id === defaultEffort}
                        disabled={disabled}
                        onClick={() => onEffort(effort.id)}
                      />
                    ))}
                  </div>
                )}
              </Tabs.Content>
            ) : null}
            <Tabs.Content value="mode" className="min-h-0 overflow-y-auto overscroll-contain p-2 outline-none">
              {!settings?.mode || !modes.some((mode) => mode.id === settings.mode) ? (
                <p className="break-words px-2 py-2 text-xs text-[var(--text-secondary)]">Current mode: {settings?.mode ?? "Not reported"}.</p>
              ) : null}
              <div data-testid="mode-select" aria-label="Modes">
                {modes.map((mode) => (
                  <SettingOption
                    key={mode.id}
                    id={`mode-option-${mode.id}`}
                    label={mode.name}
                    description={mode.description}
                    current={mode.id === settings?.mode}
                    disabled={disabled}
                    onClick={() => onMode(mode.id)}
                  />
                ))}
              </div>
            </Tabs.Content>
          </Tabs.Root>
          <footer className="shrink-0 border-t border-[var(--border-subtle)] px-4 py-2 text-xs leading-5 text-[var(--text-secondary)]">
            <p>{session.runtimeStatus === "running" ? "Changes apply to the next turn. Current work keeps its settings." : "Select a setting for your next message."}</p>
            {status ? <p className="mt-1 max-h-20 overflow-y-auto break-words" role="status">{status}</p> : null}
          </footer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SettingsTab({ value, children }: { readonly value: SettingsSection; readonly children: string }) {
  return (
    <Tabs.Trigger
      value={value}
      className="min-h-11 flex-1 border-b-2 border-transparent px-2 py-2 text-sm font-medium text-[var(--text-secondary)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] data-[state=active]:border-[var(--accent)] data-[state=active]:text-[var(--text-primary)]"
    >
      {children}
    </Tabs.Trigger>
  );
}

function SettingOption({ id, label, description, detail, current, defaultChoice, disabled, onClick }: {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly detail?: string | undefined;
  readonly current: boolean;
  readonly defaultChoice?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={current}
      disabled={disabled || current}
      onClick={onClick}
      data-testid={id}
      className={classes(
        "flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2.5 text-left text-sm outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] disabled:cursor-default",
        current && "bg-[var(--surface-base)]",
        disabled && !current && "opacity-50",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-words font-medium">{label}</span>
          {current ? <span className="text-xs text-[var(--accent)]">Current</span> : null}
          {defaultChoice ? <span className="text-xs text-[var(--text-secondary)]" title="Default reported by the model catalog">Default</span> : null}
        </span>
        {detail ? <span className="mt-0.5 block break-all font-mono text-xs text-[var(--text-secondary)]">{detail}</span> : null}
        {description ? <span className="mt-0.5 block break-words text-xs leading-5 text-[var(--text-secondary)]">{description}</span> : null}
      </span>
      {current ? <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" /> : null}
    </button>
  );
}

function nativeRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function reasoningChoices(value: unknown): Array<{ id: string; description?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const choices = value.flatMap((choice) => {
    const native = nativeRecord(choice);
    if (typeof native?.reasoningEffort !== "string" || !native.reasoningEffort || seen.has(native.reasoningEffort)) return [];
    seen.add(native.reasoningEffort);
    return [{
      id: native.reasoningEffort,
      ...(typeof native.description === "string" ? { description: native.description } : {}),
    }];
  });
  return choices.length || !value.length ? choices : undefined;
}

function settingLabel(value: string): string {
  return value.replace(/^\w/, (letter) => letter.toUpperCase());
}
