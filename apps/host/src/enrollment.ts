import { randomBytes, timingSafeEqual } from "node:crypto";
import { link, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory, writePrivateFile } from "./private-state.js";

/** Join the existing private fleet before identities or host state are created. */
export async function importEnrollmentSecret(stateDirectory: string, inputFile: string): Promise<void> {
  if ((await stat(inputFile)).size > 4096) throw new Error("Enrollment secret file is invalid");
  const value = (await readFile(inputFile, "utf8")).trim();
  if (Buffer.byteLength(value) < 32 || /\s/.test(value)) throw new Error("Enrollment secret file is invalid");
  await privateDirectory(stateDirectory);
  const target = join(stateDirectory, "shared-secret");
  const candidate = join(stateDirectory, `.enrollment-${randomBytes(8).toString("hex")}`);
  await writePrivateFile(candidate, value + "\n");
  try {
    await link(candidate, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = Buffer.from((await readFile(target, "utf8")).trim());
    const incoming = Buffer.from(value);
    if (current.length !== incoming.length || !timingSafeEqual(current, incoming)) throw new Error("This host is already initialized with another enrollment secret; it was not replaced");
  } finally { await unlink(candidate); }
}
