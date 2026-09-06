import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hostConfig } from "../apps/host/src/config.js";
import { writePrivateFile } from "../apps/host/src/private-state.js";
import { installedWorkCommands } from "../apps/host/src/work-commands.js";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it.skipIf(process.platform !== "linux")("enables commands only through an installed work marker, never a personal Codex profile", async () => {
  const state = await mkdtemp(join(tmpdir(), "leo-work-marker-")); directories.push(state);
  const environment = { LEO_STATE_DIR: state, LEO_ALLOWED_ROOTS: JSON.stringify([state]) };
  const personal = hostConfig({ ...environment, LEO_HARNESS: "codex" });
  const copilot = hostConfig({ ...environment, LEO_HARNESS: "copilot" });
  expect(await installedWorkCommands(personal)).toBeUndefined();
  expect(await installedWorkCommands(copilot)).toBeUndefined();
  await writePrivateFile(join(state, "work-commands.json"), JSON.stringify({ version: 1, platform: "wsl" }));
  await expect(installedWorkCommands(personal)).rejects.toThrow("Copilot");
  vi.stubEnv("WSL_DISTRO_NAME", "DisposableFixture");
  expect(await installedWorkCommands(copilot)).toEqual({ version: 1, platform: "wsl" });
  await writePrivateFile(join(state, "work-commands.json"), JSON.stringify({ version: 1, platform: "windows" }));
  await expect(installedWorkCommands(copilot)).rejects.toThrow("original Windows or WSL");
});
