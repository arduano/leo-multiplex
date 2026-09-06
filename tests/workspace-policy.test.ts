import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hostConfig } from "../apps/host/src/config.js";
import { workspaceRuntimeOptions } from "../apps/host/src/main.js";
import { UnrestrictedWorkspacePolicy } from "../apps/host/src/workspace-policy.js";

it("maps unrestricted WSL to / and Windows to the checked static policy hook", async () => {
  const wsl = hostConfig({ HOME: "/home/fixture", LEO_HARNESS: "copilot", LEO_ALLOWED_ROOTS: '"*"' }, "linux");
  expect(wsl).toMatchObject({ unrestrictedPaths: true, allowedRoots: ["/"] });
  expect(workspaceRuntimeOptions(wsl, "linux", {})).toEqual({});
  const windows = hostConfig({ USERPROFILE: "C:\\Users\\Fixture", LEO_HARNESS: "copilot", LEO_ALLOWED_ROOTS: '"*"' }, "win32");
  expect(windows).toMatchObject({ unrestrictedPaths: true, allowedRoots: [] });
  expect(() => workspaceRuntimeOptions(windows, "win32", {})).toThrow("framework path-policy update");
  expect(() => workspaceRuntimeOptions(windows, "win32", { runtimePathPolicyInjectionVersion: 2 })).toThrow();
  const options = workspaceRuntimeOptions(windows, "win32", { runtimePathPolicyInjectionVersion: 1 });
  expect(options.pathPolicy).toBeInstanceOf(UnrestrictedWorkspacePolicy);
  expect(await options.pathPolicy!.roots()).toEqual([]);
  expect(hostConfig({ HOME: "/home/fixture", LEO_HARNESS: "copilot" })).toMatchObject({ unrestrictedPaths: false, allowedRoots: ["/home/fixture"] });
  expect(hostConfig({ HOME: "/home/fixture" })).toMatchObject({ unrestrictedPaths: false, allowedRoots: ["/"] });
});

it("accepts existing directories outside a configured home and validates paths without making missing directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "leo-any-workspace-"));
  try {
    const policy = new UnrestrictedWorkspacePolicy();
    const first = join(directory, "one"), second = join(directory, "two");
    await mkdir(first); await mkdir(second);
    expect(await policy.validate(first)).toBe(first);
    expect(await policy.validate(second)).toBe(second);
    const file = join(directory, "attachment"); await writeFile(file, "fixture");
    expect(await policy.validatePath(file)).toBe(file);
    await expect(policy.validate(file)).rejects.toThrow("existing directory");
    await expect(policy.validate("relative")).rejects.toThrow("absolute");
    await expect(policy.validate(join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
