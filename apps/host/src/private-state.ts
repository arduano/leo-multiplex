import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Managed state must use a real directory");
  await chmod(path, 0o700);
}

async function verifyPrivateTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Managed state file must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await privateDirectory(dirname(path));
  await verifyPrivateTarget(path);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function sharedSecret(stateDirectory: string): Promise<string> {
  await privateDirectory(stateDirectory);
  const filename = join(stateDirectory, "shared-secret");
  await verifyPrivateTarget(filename);
  try {
    const value = (await readFile(filename, "utf8")).trim();
    if (Buffer.byteLength(value) < 32) throw new Error("Managed shared secret is invalid");
    await chmod(filename, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const candidate = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  await writePrivateFile(candidate, randomBytes(48).toString("base64") + "\n");
  try {
    await link(candidate, filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(candidate);
  }
  return sharedSecret(stateDirectory);
}
