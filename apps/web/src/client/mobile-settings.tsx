import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, Camera, Download, ImagePlus, RefreshCw, Trash2 } from "lucide-react";
import { createAccessClient } from "@arduano/agent-multiplex-client/browser";
import { v4 as uuid } from "uuid";
import { prepareImageFile } from "./image-media.js";
import { useDismissOnBack } from "./mobile-navigation.js";
import { Button, Input, Textarea } from "./ui.js";
import { currentDeviceId, enableNotifications, mobileRequest, revokeDevice, saveDeviceSettings, useMobileState, type MobileDevice } from "./mobile-api.js";
import { installPwa, updatePwa, usePwa } from "./pwa.js";
import { clearEmptyDeviceData, deleteDraft, draftStorageUsage, draftVersion, flushDrafts, listDrafts, subscribeDrafts, useSessionDraft, type DraftSummary } from "./session-drafts.js";
import { dispatchSavedOperation, settleOperation, listOperations, operationFinished, reconcileOperation, type SavedOperation } from "./operation-recovery.js";

export function MobileSettings({ onClose, offline = false }: { onClose?: (() => void) | undefined; offline?: boolean }) {
  const pwa = usePwa();
  const mobile = useMobileState(!offline);
  const query = useQueryClient();
  const version = useSyncExternalStore(subscribeDrafts, draftVersion);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [operations, setOperations] = useState<SavedOperation[]>([]);
  const [usage, setUsage] = useState("");
  const [name, setName] = useState("My Android phone");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<DraftSummary | null>(null);
  const actionLock = useRef(false);
  const ownDevice = mobile.data?.devices.find(device => device.id === currentDeviceId());
  async function refreshLocal() {
    const [drafts, operations, storage] = await Promise.all([listDrafts(), listOperations(), draftStorageUsage()]);
    setDrafts(drafts); setOperations(operations);
    setUsage(`${(storage.bytes / 1_048_576).toFixed(1)} / ${storage.budgetBytes / 1_048_576} MiB saved on this device`);
  }
  useEffect(() => { void refreshLocal().catch(error => setStatus(message(error))); }, [version]);
  async function action(work: () => Promise<unknown>) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setStatus("");
    try { await work(); await Promise.all([query.invalidateQueries({ queryKey: ["mobile-state"] }), refreshLocal()]); }
    catch (error) { setStatus(message(error)); }
    finally { actionLock.current = false; setBusy(false); }
  }
  async function saveCategories(device: MobileDevice, key: "completion" | "input" | "error", enabled: boolean) {
    await saveDeviceSettings({ ...device, categories: { ...device.categories, [key]: enabled } });
  }
  if (editing) return <SavedDraftEditor draft={editing} offline={offline} onClose={() => { setEditing(null); void refreshLocal(); }} />;
  return <section className="flex min-h-0 flex-1 flex-col" data-testid="mobile-settings">
    <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-3">
      {onClose ? <Button tone="ghost" icon={ArrowLeft} aria-label="Back to agents" onClick={onClose} /> : null}
      <h1 className="text-base font-semibold">{offline ? "Offline drafts" : "App settings"}</h1>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
      {offline ? <p className="mt-4 text-sm text-[var(--text-secondary)]">Your saved work is here. Reconnect to read agent history or send.</p> : <>
        <section className="border-b border-[var(--border-subtle)] py-5">
          <h2 className="mb-3 text-sm font-semibold">Install and updates</h2>
          {pwa.installed ? <p className="text-sm text-[var(--text-secondary)]">Installed on this device.</p> : pwa.installable ? <Button icon={Download} onClick={() => void action(installPwa)} disabled={busy}>Install Leo agents</Button> : <p className="text-sm text-[var(--text-secondary)]">In Chrome, open the menu and choose Add to Home screen or Install app. Use https://agents.arduano.io.</p>}
          {pwa.updateAvailable ? <Button className="mt-3" icon={RefreshCw} disabled={busy} onClick={() => void action(updatePwa)}>Save drafts and update</Button> : null}
          {pwa.error ? <p className="mt-2 text-sm text-[var(--status-waiting)]">{pwa.error}</p> : null}
        </section>
        <section className="border-b border-[var(--border-subtle)] py-5">
          <h2 className="mb-2 text-sm font-semibold">Notifications</h2>
          <p className="mb-3 text-sm text-[var(--text-secondary)]">Only watched agents notify you. Alerts show the agent title and status, including while this app is closed.</p>
          {!ownDevice ? <div className="flex flex-wrap items-center gap-2"><Input className="min-w-40 flex-1" aria-label="Device name" value={name} maxLength={80} onChange={event => setName(event.target.value)} /><Button icon={Bell} disabled={busy || !name.trim()} onClick={() => void action(() => enableNotifications(name.trim()))}>Enable notifications</Button></div> : <>
            {([ ["completion", "Finished"], ["input", "Needs input"], ["error", "Failed"] ] as const).map(([key, label]) => <label className="flex min-h-11 items-center gap-3 text-sm" key={key}><input type="checkbox" checked={ownDevice.categories[key]} disabled={busy} onChange={event => void action(() => saveCategories(ownDevice, key, event.target.checked))} />{label}</label>)}
            <div className="mt-2 flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void action(async () => { await mobileRequest(`devices/${ownDevice.id}/test`, "POST"); setStatus("Test notification queued. Lock your phone to check background delivery."); })}>Send test notification</Button><Button tone="ghost" disabled={busy} onClick={() => void action(() => revokeDevice(ownDevice.id))}>Disable on this device</Button></div>
          </>}
          {mobile.data?.delivery?.lastError ? <p className="mt-2 text-sm text-[var(--status-waiting)]">{mobile.data.delivery.lastError}</p> : null}
          {mobile.isError ? <p className="mt-2 text-sm text-[var(--status-waiting)]">Notification settings are unavailable. Reconnect to try again.</p> : null}
          {mobile.data?.devices.length ? <div className="mt-4 divide-y divide-[var(--border-subtle)]">{mobile.data.devices.map(device => <div className="flex items-center justify-between gap-2 py-2 text-sm" key={device.id}><span className="min-w-0 truncate">{device.name}{device.id === currentDeviceId() ? " · this device" : ""}</span><Button tone="ghost" disabled={busy} onClick={() => { if (window.confirm(`Stop notifications to ${device.name}?`)) void action(() => revokeDevice(device.id)); }}>Revoke</Button></div>)}</div> : null}
        </section>
      </>}
      <section className="border-b border-[var(--border-subtle)] py-5">
        <h2 className="mb-2 text-sm font-semibold">Saved drafts</h2>
        <p className="mb-3 text-xs text-[var(--text-secondary)]">{usage || "Loading local storage…"}. Drafts stay on this device; they are not synced to other devices.</p>
        <Button tone="ghost" disabled={busy} onClick={() => void action(async () => { const granted = await navigator.storage?.persist?.(); setStatus(granted ? "Chrome will protect saved work from automatic storage cleanup." : "Chrome manages storage automatically. Drafts remain saved, but device cleanup can remove them."); })}>Protect saved work</Button>
        <div className="mt-2 divide-y divide-[var(--border-subtle)]">{drafts.map(draft => <div className="flex min-w-0 items-center gap-2 py-2" key={draft.id}>
          <button className="min-h-11 min-w-0 flex-1 py-2 text-left" onClick={() => setEditing(draft)}><span className="block truncate text-sm">{draft.conflict ? "Recovered other-window draft · " : ""}{draft.prompt.trim() || "Image draft"}</span><span className="text-xs text-[var(--text-secondary)]">{draft.imageCount ? `${draft.imageCount} image${draft.imageCount === 1 ? "" : "s"} · ` : ""}{draft.uncertain ? "Check pending command" : "Saved locally"}</span></button>
          <Button icon={Trash2} aria-label="Delete saved draft" tone="ghost" disabled={busy || draft.uncertain} onClick={() => { if (window.confirm("Delete this draft and its unsent images?")) void action(() => deleteDraft(draft.id)); }} />
        </div>)}</div>
        {!drafts.length ? <p className="mt-3 text-sm text-[var(--text-secondary)]">No unsent drafts.</p> : null}
      </section>
      {operations.length ? <section className="py-5"><h2 className="mb-2 text-sm font-semibold">Pending actions</h2><p className="mb-3 text-sm text-[var(--text-secondary)]">Check the host receipt before deciding to retry an interrupted action.</p>{operations.map(operation => <OperationRecovery key={operation.id} operation={operation} disabled={offline || busy} onChanged={() => void refreshLocal()} />)}</section> : null}
      <Button className="mt-4" tone="ghost" disabled={busy} onClick={() => void action(async () => { await clearEmptyDeviceData(); setStatus("Empty draft records cleared. Push settings are managed above; signing out retains unsent drafts."); })}>Clear empty local data</Button>
      <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--status-waiting)]" role="status">{status}</p>
    </div>
  </section>;
}

function SavedDraftEditor({ draft, offline, onClose }: { draft: DraftSummary; offline: boolean; onClose: () => void }) {
  const value = useSessionDraft(draft.id.slice("draft:".length));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void value.save().catch(() => {}); }; }, [value.save]);
  useDismissOnBack(true, () => { void save(true); });
  async function save(close: boolean): Promise<boolean> {
    try { await value.save(); setStatus("Saved on this device"); if (close) onClose(); return true; }
    catch (error) { setStatus(message(error)); return false; }
  }
  async function attach(files: File[]) {
    if (lock.current || value.uncertain || !value.loaded) return;
    lock.current = true; setBusy(true);
    try {
      if (value.images.length + files.length > 10) throw new Error("Attach at most 10 images");
      const prepared = await Promise.all(files.map(prepareImageFile));
      if (!mounted.current) return;
      if ([...value.images.map(image => image.file), ...prepared].reduce((bytes, file) => bytes + file.size, 0) > 50 * 1_024 * 1_024) throw new Error("Image attachments exceed 50 MiB");
      value.setImages(images => [...images, ...prepared.map(file => ({ id: uuid(), file, url: URL.createObjectURL(file) }))]);
      await value.save(); setStatus("Saved on this device");
    } catch (error) { setStatus(message(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="flex min-h-0 flex-1 flex-col p-4" data-testid="saved-draft-editor">
    <header className="mb-3 flex items-center gap-3"><Button icon={ArrowLeft} tone="ghost" aria-label="Back to saved drafts" disabled={busy} onClick={() => void save(true)} /><h1 className="text-base font-semibold">Saved draft</h1></header>
    <Textarea className="min-h-24 flex-1 resize-none text-base" aria-label="Saved message draft" value={value.prompt} disabled={!value.loaded || Boolean(value.uncertain)} onChange={event => value.setPrompt(event.target.value)} />
    {value.images.length ? <div className="mt-3 flex max-h-36 gap-2 overflow-x-auto">{value.images.map(image => <div key={image.id} className="shrink-0"><img className="h-20 max-w-32 object-contain" src={image.url} alt={image.file.name} /><Button tone="ghost" icon={Trash2} aria-label={`Remove ${image.file.name}`} disabled={busy || Boolean(value.uncertain)} onClick={() => { value.setImages(images => images.filter(item => item.id !== image.id)); URL.revokeObjectURL(image.url); }}>Remove</Button></div>)}</div> : null}
    <input type="file" ref={gallery} multiple accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" className="hidden" data-testid="saved-gallery-input" onChange={event => { void attach([...(event.target.files ?? [])]); event.target.value = ""; }} />
    <input type="file" ref={camera} accept="image/*" capture="environment" className="hidden" data-testid="saved-camera-input" onChange={event => { void attach([...(event.target.files ?? [])]); event.target.value = ""; }} />
    <div className="mt-3 flex flex-wrap gap-2"><Button icon={ImagePlus} disabled={busy || !value.loaded || Boolean(value.uncertain)} onClick={() => gallery.current?.click()}>Gallery</Button><Button icon={Camera} disabled={busy || !value.loaded || Boolean(value.uncertain)} onClick={() => camera.current?.click()}>Camera</Button>{!offline && !draft.conflict ? <Button disabled={busy || !value.loaded} onClick={async () => { if (await save(false)) window.location.hash = `#/agents/${draft.sessionId}`; }}>Open agent</Button> : null}</div>
    <p className="mt-2 text-sm text-[var(--status-waiting)]" role="status">{value.uncertain ? "This draft belongs to a pending command. Check the original action before editing." : value.saveError || status || "Draft changes save automatically on this device."}</p>
  </section>;
}

function OperationRecovery({ operation, disabled, onChanged }: { operation: SavedOperation; disabled: boolean; onChanged: () => void }) {
  const actionLock = useRef(false);
  const [status, setStatus] = useState(""); const [checked, setChecked] = useState(false); const [busy, setBusy] = useState(false);
  async function check(retry: boolean) {
    if (actionLock.current) return; actionLock.current = true; setBusy(true);
    const handle = createAccessClient({ httpUrl: new URL("/trpc", location.href).href });
    try {
      await flushDrafts();
      let receipt = await reconcileOperation(handle.client, operation);
      if (retry && !operationFinished(receipt)) receipt = await dispatchSavedOperation(handle.client, operation);
      if (operationFinished(receipt)) { await settleOperation(operation, receipt); setStatus(`Host reports ${receipt!.state}.`); onChanged(); }
      else { setChecked(true); setStatus(receipt ? `Host reports ${receipt.state}.` : "No receipt yet. The original action may still have run."); }
    } catch (error) { setStatus(message(error)); }
    finally { handle.close(); actionLock.current = false; setBusy(false); }
  }
  return <div className="border-t border-[var(--border-subtle)] py-3"><p className="text-sm">{operation.kind === "launch" ? "New agent" : operation.kind === "resolve" ? "Agent answer" : "Agent command"} · {new Date(operation.updatedAt).toLocaleString()}</p><div className="mt-2 flex flex-wrap gap-2"><Button disabled={disabled || busy} onClick={() => void check(false)}>Check original action</Button>{checked ? <Button disabled={disabled || busy} onClick={() => { if (window.confirm("Retry this exact saved action with its original ID?")) void check(true); }}>Retry original action</Button> : null}</div><p className="mt-2 text-xs text-[var(--status-waiting)]" role="status">{status}</p></div>;
}
function message(error: unknown) { return error instanceof Error ? error.message : "This action could not be completed."; }
