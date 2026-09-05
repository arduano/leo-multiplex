import { mkdtemp, readFile, stat, symlink, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, expect, it } from "vitest";

import { hostConfig } from "../apps/host/src/config.js";
import { prepareManagedCodexConfig, selectCodexConfig } from "../apps/host/src/codex-config.js";
import { sharedSecret, writePrivateFile } from "../apps/host/src/private-state.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() { const path = await mkdtemp(join(tmpdir(), "leo-host-test-")); directories.push(path); return path; }
const source = `model = "test-model"
model_provider = "test-provider"
model_reasoning_effort = "high"
unrelated = "do-not-copy"
[model_providers.test-provider]
name = "Fixture provider"
base_url = "http://127.0.0.1:1/v1"
wire_api = "responses"
requires_openai_auth = false
[model_providers.test-provider.auth]
command = "/bin/cat"
args = ["/nonexistent/disposable-credential"]
refresh_interval_ms = 300000
`;

it("defaults to local host state and an explicitly closed gateway enrollment aperture", () => {
  expect(hostConfig({ HOME: "/disposable" })).toMatchObject({ stateDirectory: "/disposable/.local/state/leo-multiplex", codexConfigFile: "/disposable/.codex/config.toml", name: "main-pc", enrollGateways: false });
  expect(() => hostConfig({ HOME: "/disposable", LEO_CONTROL_HTTP_PORT: "NaN" })).toThrow("port");
});

it("copies only the selected provider and defaults, retaining the auth reference without reading it", async () => {
  const directory = await fixture();
  const nativeHome = join(directory, "existing");
  await mkdir(nativeHome);
  const original = join(nativeHome, "config.toml");
  await writeFile(original, source);
  const state = join(directory, "managed");
  const selected = await prepareManagedCodexConfig(original, state);
  const content = await readFile(join(selected.home, "config.toml"), "utf8");
  const copied = parse(content);
  expect(copied).toMatchObject({ model: "test-model", model_provider: "test-provider", approval_policy: "never", sandbox_mode: "danger-full-access" });
  expect(copied.unrelated).toBeUndefined();
  expect(copied.model_providers).toEqual(parse(source).model_providers);
  expect(await readFile(original, "utf8")).toBe(source);
  expect((await stat(selected.home)).mode & 0o777).toBe(0o700);
  expect((await stat(join(selected.home, "config.toml"))).mode & 0o777).toBe(0o600);
});

it("refuses managed-home symlinks and state within the existing Codex home", async () => {
  const directory = await fixture();
  const oldHome = join(directory, "old");
  const state = join(directory, "state");
  await mkdir(oldHome); await mkdir(state);
  const original = join(oldHome, "config.toml");
  await writeFile(original, source);
  await symlink(oldHome, join(state, "codex"));
  await expect(prepareManagedCodexConfig(original, state)).rejects.toThrow("real directory");
  await expect(prepareManagedCodexConfig(original, join(oldHome, "managed"))).rejects.toThrow("outside");
  const alias = join(directory, "alias");
  await symlink(oldHome, alias);
  await expect(prepareManagedCodexConfig(original, join(alias, "managed"))).rejects.toThrow("outside");
  await expect(stat(join(oldHome, "managed"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(original, "utf8")).toBe(source);
});

it("does not include malformed provider content in validation errors", () => {
  expect(() => selectCodexConfig('sensitive = "fixture-secret')).toThrow("invalid TOML");
});

it("creates one durable private shared secret across concurrent initializers", async () => {
  const directory = await fixture();
  const values = await Promise.all(Array.from({ length: 5 }, () => sharedSecret(directory)));
  expect(new Set(values).size).toBe(1);
  expect((await stat(join(directory, "shared-secret"))).mode & 0o777).toBe(0o600);
  await writePrivateFile(join(directory, "source.json"), "{}");
  expect((await stat(join(directory, "source.json"))).mode & 0o777).toBe(0o600);
});
