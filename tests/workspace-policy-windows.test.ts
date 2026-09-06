import { expect, it, vi } from "vitest";

vi.mock("node:path", async original => {
  const paths = await original<typeof import("node:path")>();
  return { ...paths, ...paths.win32 };
});
vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (path: string) => path.replaceAll("/", "\\")),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}));

import { realpath } from "node:fs/promises";
import { UnrestrictedWorkspacePolicy } from "../apps/host/src/workspace-policy.js";

it("admits C:, D:, later drives and UNC shares without listing drives at startup", async () => {
  const policy = new UnrestrictedWorkspacePolicy();
  expect(await policy.roots()).toEqual([]);
  for (const path of ["C:/Work/project", "D:/repos/project", "Z:/later-mounted/project", "\\\\server\\share\\project"]) {
    expect(await policy.validate(path)).toBe(path.replaceAll("/", "\\"));
  }
  await expect(policy.validate("D:relative")).rejects.toThrow("absolute");
  await expect(policy.validate("relative")).rejects.toThrow("absolute");
  vi.mocked(realpath).mockRejectedValueOnce(Object.assign(new Error("inaccessible"), { code: "EACCES" }));
  await expect(policy.validate("D:/inaccessible")).rejects.toMatchObject({ code: "EACCES" });
});
