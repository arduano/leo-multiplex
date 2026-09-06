import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { importEnrollmentSecret } from "../apps/host/src/enrollment.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const path = await mkdtemp(join(tmpdir(), "leo-enrollment-")); directories.push(path); return path; }
const secret = "disposable-fixture-secret-".repeat(3);

it("imports an existing fleet secret without replacing an initialized host's secret", async () => {
  const directory = await fixture(), state = join(directory, "state"), input = join(directory, "import");
  await writeFile(input, secret);
  await Promise.all([importEnrollmentSecret(state, input), importEnrollmentSecret(state, input)]);
  expect((await readFile(join(state, "shared-secret"), "utf8")).trim()).toBe(secret);
  await writeFile(input, "different-disposable-secret".repeat(3));
  await expect(importEnrollmentSecret(state, input)).rejects.toThrow("not replaced");
  expect((await readFile(join(state, "shared-secret"), "utf8")).trim()).toBe(secret);
});

it("merges both work command pins beside the four core sources and rejects orphan/colliding pins", async () => {
  const directory = await fixture(), existing = join(directory, "personal.json"), incoming = join(directory, "incoming.json");
  const source = (sourceId: string, letter: string) => ({ sourceId, endpointId: letter.repeat(52), locator: { kind: "ticket", ticket: "disposable-ticket" } });
  const work = (platform: "windows" | "wsl", letter: string) => ({ sourceId: `work-${platform}`, name: `Work ${platform}`, platform, endpointId: letter.repeat(52), locator: { kind: "ticket", ticket: "disposable-work-ticket" } });
  const personal = { version: 1, sharedSecret: secret, sources: [source("main-pc", "a"), source("home-nas", "b")] };
  await writeFile(existing, JSON.stringify(personal));
  const run = promisify(execFile);
  let current = existing;
  for (const [platform, corePin, workPin] of [["windows", "c", "d"], ["wsl", "e", "f"]] as const) {
    await writeFile(incoming, JSON.stringify({ version: 1, sharedSecret: secret, sources: [source(`work-${platform}`, corePin)], workHosts: [work(platform, workPin)] }));
    const output = join(directory, `${platform}.json`);
    await run(process.execPath, ["scripts/merge-pairing.mjs", current, incoming, output]);
    current = output;
  }
  const merged = JSON.parse(await readFile(current, "utf8"));
  expect(merged.sources).toEqual([...personal.sources, source("work-windows", "c"), source("work-wsl", "e")]);
  expect(merged.workHosts).toEqual([work("windows", "d"), work("wsl", "f")]);
  expect(JSON.parse(await readFile(existing, "utf8"))).toEqual(personal);
  for (const descriptor of [work("windows", "a"), work("wsl", "d")]) {
    await writeFile(incoming, JSON.stringify({ version: 1, sharedSecret: secret, sources: [source("work-windows", "c")], workHosts: [descriptor] }));
    await expect(run(process.execPath, ["scripts/merge-pairing.mjs", existing, incoming, join(directory, "rejected.json")])).rejects.toMatchObject({ code: 1 });
  }
});

it("merges a new host while retaining existing sources and refusing conflicts or overwrite", async () => {
  const directory = await fixture(), existing = join(directory, "existing.json"), incoming = join(directory, "incoming.json"), output = join(directory, "output.json");
  const source = (name: string) => ({ sourceId: name, endpointId: `${name}-endpoint`, locator: { kind: "ticket", ticket: `${name}-disposable-ticket` } });
  const old = JSON.stringify({ version: 1, sharedSecret: secret, sources: [source("main-pc"), source("home-nas")] });
  await writeFile(existing, old);
  await writeFile(incoming, JSON.stringify({ version: 1, sharedSecret: secret, sources: [source("work-laptop")] }));
  const run = promisify(execFile);
  const args = ["scripts/merge-pairing.mjs", existing, incoming, output];
  const result = await run(process.execPath, args);
  expect(result.stdout).toContain("3 sources");
  expect(result.stdout).not.toContain(secret);
  expect(JSON.parse(await readFile(output, "utf8")).sources).toHaveLength(3);
  expect(await readFile(existing, "utf8")).toBe(old);
  await expect(run(process.execPath, args)).rejects.toMatchObject({ code: 1 });
  await writeFile(incoming, JSON.stringify({ version: 1, sharedSecret: "different-disposable-secret".repeat(3), sources: [source("work-laptop")] }));
  await expect(run(process.execPath, ["scripts/merge-pairing.mjs", existing, incoming, join(directory, "new.json")])).rejects.toMatchObject({ code: 1 });
});
