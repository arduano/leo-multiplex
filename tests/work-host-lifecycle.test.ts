import { afterEach, expect, it, vi } from "vitest";
import { runWorkLaptop } from "../apps/host/src/manage.js";
import { hostConfig } from "../apps/host/src/config.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const controller = new AbortController();
  const wait = (signal: AbortSignal) => signal.aborted ? Promise.resolve() : new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  const pairing = { sourceId: "work-wsl", endpointId: "a".repeat(52), name: "Work WSL", platform: "wsl" as const, locator: { kind: "ticket" as const, ticket: "disposable-fixture" } };
  const close = vi.fn(async () => {});
  const dependencies = {
    commands: vi.fn(async () => ({ pairing, close })),
    control: vi.fn(async (_config, signal, ready) => { ready?.(); await wait(signal); }),
    doctor: vi.fn(async () => ({ version: 1 as const, ok: true, checks: [] })),
    runtime: vi.fn(async (_config, signal) => { await wait(signal); }),
  } satisfies NonNullable<Parameters<typeof runWorkLaptop>[3]>;
  const config = hostConfig({ LEO_HARNESS: "copilot", LEO_STATE_DIR: "/tmp/disposable-work-lifecycle", LEO_ALLOWED_ROOTS: '["/tmp"]' });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { controller, config, dependencies, close, pairing };
}

it("keeps the work recovery service and control online when Copilot doctor fails", async () => {
  const f = fixture();
  f.dependencies.doctor.mockResolvedValue({ version: 1, ok: false, checks: [] });
  const running = runWorkLaptop(f.config, f.controller.signal, {}, f.dependencies);
  try {
    await vi.waitFor(() => expect(f.dependencies.doctor).toHaveBeenCalledOnce());
    expect(f.dependencies.runtime).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.dependencies.control.mock.calls[0]?.[3]).toEqual(f.pairing);
  } finally { f.controller.abort(); await running; }
  expect(f.close).toHaveBeenCalledOnce();
});

it("keeps command recovery up when native startup fails and emits no upstream diagnostic", async () => {
  const f = fixture();
  f.dependencies.runtime.mockRejectedValue(new Error("private-provider-fixture"));
  const running = runWorkLaptop(f.config, f.controller.signal, {}, f.dependencies);
  try {
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private-provider-fixture");
    expect(f.close).not.toHaveBeenCalled();
  } finally { f.controller.abort(); await running; }
});

it("does not start the native runtime if control never becomes ready", async () => {
  const f = fixture();
  f.dependencies.control.mockImplementation(async () => {});
  const running = runWorkLaptop(f.config, f.controller.signal, {}, f.dependencies);
  try {
    await vi.waitFor(() => expect(f.dependencies.control).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.dependencies.doctor).not.toHaveBeenCalled();
    expect(f.dependencies.runtime).not.toHaveBeenCalled();
  } finally { f.controller.abort(); await running; }
});

it("does not start native work after cancellation during doctor", async () => {
  const f = fixture();
  let finish!: () => void;
  f.dependencies.doctor.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ version: 1, ok: true, checks: [] }); }));
  const running = runWorkLaptop(f.config, f.controller.signal, {}, f.dependencies);
  await vi.waitFor(() => expect(f.dependencies.doctor).toHaveBeenCalledOnce());
  f.controller.abort(); finish(); await running;
  expect(f.dependencies.runtime).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
  await runWorkLaptop(f.config, f.controller.signal, {}, f.dependencies);
  expect(f.dependencies.commands).toHaveBeenCalledOnce();
});
