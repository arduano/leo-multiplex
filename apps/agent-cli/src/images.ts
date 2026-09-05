import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { imageTarget, readImage, uploadImage, type AccessClient } from "@arduano/agent-multiplex-client";
import {
  IMAGE_MAX_BYTES, IMAGE_MAX_COMMAND_IMAGES, assertImageResponseTarget, imageDescriptorSchema, imageIdSchema, imageReadResultSchema,
  type ImageDescriptor, type ImageMediaType, type RuntimeNodeDescriptor, type SessionRecord,
} from "@arduano/agent-multiplex-protocol";
import { jsonFile, option, required, type Arguments } from "./input.js";
import { CliError } from "./output.js";

function imageId(value: string): string {
  const parsed = imageIdSchema.safeParse(value);
  if (!parsed.success) throw new CliError("USAGE", "--image-id must be a UUID");
  return parsed.data;
}

function mediaType(bytes: Buffer): ImageMediaType {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new CliError("UNSUPPORTED_IMAGE", "Upload a PNG, JPEG, GIF, or WebP image; convert SVG locally first");
}

async function inputImage(filename: string, signal: AbortSignal): Promise<Buffer> {
  if (filename === "-") throw new CliError("USAGE", "--file requires a regular image file");
  signal.throwIfAborted();
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || !before.size || before.size > IMAGE_MAX_BYTES) {
      throw new CliError("INVALID_IMAGE_FILE", "Image input must be a nonempty regular file no larger than 10 MiB");
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new CliError("INPUT_CHANGED", "Image input changed while reading; retry after the file is stable");
    }
    signal.throwIfAborted();
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}

async function saveImage(output: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST" || error.code === "ELOOP") throw new CliError("OUTPUT_EXISTS", "Output already exists; choose a new --output path");
      throw error;
    });
  const owned = await file.stat();
  try {
    await file.writeFile(bytes, { signal });
    signal.throwIfAborted();
    await file.sync();
    signal.throwIfAborted();
  } catch (error) {
    // A caller may rename the destination while we write; never unlink its replacement.
    const current = await lstat(output).catch(() => undefined);
    if (current?.dev === owned.dev && current.ino === owned.ino) await unlink(output).catch(() => undefined);
    throw error;
  } finally { await file.close(); }
}

/** Transfer images only through the session's current runtime/binding/boot fence. */
export async function imageCommand(
  args: Arguments, client: AccessClient, session: SessionRecord, runtime: RuntimeNodeDescriptor, signal: AbortSignal,
) {
  signal.throwIfAborted();
  const target = imageTarget(session, runtime);
  if (args.command === "image-upload") {
    const id = imageId(required(args, "image-id"));
    const bytes = await inputImage(required(args, "file"), signal);
    const image = await uploadImage(client, target, bytes, mediaType(bytes), { imageId: id, signal });
    return { image };
  }
  if (args.command !== "image-get") throw new CliError("USAGE", "Expected image-upload or image-get");
  const id = option(args, "image-id"), path = option(args, "path");
  if (Boolean(id) === Boolean(path)) throw new CliError("USAGE", "Supply exactly one of --image-id or --path");
  if (id && option(args, "source-key") !== undefined) throw new CliError("USAGE", "--source-key requires --path");
  const filename = required(args, "output");
  if (filename === "-") throw new CliError("USAGE", "--output requires a file path; stdout is reserved for JSON");
  const output = resolve(filename);
  // Refuse an existing output before a first-display snapshot or any download.
  try {
    await lstat(output);
    throw new CliError("OUTPUT_EXISTS", "Output already exists; choose a new --output path");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let image;
  if (id) {
    // Protocol v5 has no describe procedure. A one-byte read supplies its descriptor.
    const request = { ...target, imageId: imageId(id), offset: 0, length: 1 };
    const receipt = imageReadResultSchema.parse(await client.images.read.query(request, { signal }));
    assertImageResponseTarget(request, receipt);
    image = receipt.image;
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path!) || path!.startsWith("//") || path!.includes("\0") || path!.length > 16_384) {
      throw new CliError("INVALID_IMAGE_PATH", "--path must be a runtime-local image path");
    }
    const source = option(args, "source-key") ?? path!;
    if (!source || (source.length > 4_096 && option(args, "source-key") !== undefined)) throw new CliError("USAGE", "--source-key must contain 1 to 4096 characters");
    const sourceKey = `leo-cli:path:${createHash("sha256").update(source).digest("hex")}`;
    image = imageDescriptorSchema.parse(await client.images.resolvePath.mutate({ ...target, sourceKey, path: path! }, { signal }));
    assertImageResponseTarget(target, image);
  }
  const bytes = await readImage(client, target, image, { signal });
  await saveImage(output, bytes, signal);
  return { image, output };
}

export async function imageUpload(client: AccessClient, session: SessionRecord, runtime: RuntimeNodeDescriptor, args: Arguments, signal: AbortSignal): Promise<ImageDescriptor> {
  return (await imageCommand({ ...args, command: "image-upload" }, client, session, runtime, signal)).image;
}

export async function imageGet(client: AccessClient, session: SessionRecord, runtime: RuntimeNodeDescriptor, args: Arguments, signal: AbortSignal): Promise<{ image: ImageDescriptor; path: string }> {
  const result = await imageCommand({ ...args, command: "image-get" }, client, session, runtime, signal);
  return { image: result.image, path: result.output! };
}

/** Return descriptors only; native command construction never receives bytes. */
export async function descriptors(args: Arguments, signal: AbortSignal): Promise<ImageDescriptor[]> {
  signal.throwIfAborted();
  const files = args.options["image-json"];
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > IMAGE_MAX_COMMAND_IMAGES) throw new CliError("USAGE", `Use at most ${IMAGE_MAX_COMMAND_IMAGES} --image-json files`);
  if (files.filter((file) => file === "-").length > 1) throw new CliError("USAGE", "Only one image descriptor can be read from standard input");
  if (files.includes("-") && option(args, "text-file") === "-") throw new CliError("USAGE", "Standard input cannot supply both text and an image descriptor");
  const images: ImageDescriptor[] = [];
  let total = 0;
  for (const file of files) {
    signal.throwIfAborted();
    const input = await jsonFile(file, signal);
    const envelope = input as { version?: unknown; ok?: unknown; command?: unknown; data?: { image?: unknown } } | null;
    const value = envelope?.version === 1 && envelope.ok === true && (envelope.command === "image-upload" || envelope.command === "image-get") ? envelope.data?.image : input;
    const parsed = imageDescriptorSchema.safeParse(value);
    if (!parsed.success) throw new CliError("INVALID_IMAGE_DESCRIPTOR", "Each --image-json file must contain a published image descriptor");
    total += parsed.data.byteLength;
    if (total > 50 * 1_024 * 1_024) throw new CliError("INPUT_TOO_LARGE", "Message image descriptors exceed 50 MiB");
    images.push(parsed.data);
  }
  signal.throwIfAborted();
  return images;
}

export const loadImageDescriptors = descriptors;
