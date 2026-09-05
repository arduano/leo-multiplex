import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageSha256, type AccessClient } from "@arduano/agent-multiplex-client";
import { IMAGE_MAX_BYTES, IMAGE_MAX_CHUNK_BYTES, type ImageDescriptor, type RuntimeNodeDescriptor, type SessionRecord } from "@arduano/agent-multiplex-protocol";
import { descriptors, imageCommand } from "../apps/agent-cli/src/images.js";
import { parse } from "../apps/agent-cli/src/input.js";

const directories: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlJQAAAAASUVORK5CYII=", "base64");
const session = { sessionId: randomUUID(), runtimeNodeId: randomUUID(), bindingRevision: 1 } as SessionRecord;
const runtime = { runtimeNodeId: session.runtimeNodeId, runtimeNodeBootId: randomUUID() } as RuntimeNodeDescriptor;
const signal = new AbortController().signal;
const target = { sessionId: session.sessionId, runtimeNodeId: runtime.runtimeNodeId, bindingRevision: 1, runtimeNodeBootId: runtime.runtimeNodeBootId };

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("image descriptor input files", () => {
  it("validates repeated descriptor files in their supplied order", async () => {
    const f = await fixture();
    const first = join(f.root, "one.json"), second = join(f.root, "two.json");
    const images = [f.image, { ...f.image, imageId: randomUUID() }];
    await writeFile(first, JSON.stringify(images[0])); await writeFile(second, JSON.stringify(images[1]));
    expect(await descriptors(parse(["send", "--image-json", first, "--image-json", second]), signal)).toEqual(images);
    expect(await descriptors(parse(["send"]), signal)).toEqual([]);
  });

  it("rejects invalid descriptors, excess counts, and excess aggregate image bytes", async () => {
    const f = await fixture(); const filename = join(f.root, "descriptor.json");
    await writeFile(filename, JSON.stringify({ ...f.image, byteLength: IMAGE_MAX_BYTES + 1 }));
    await expect(descriptors(parse(["send", "--image-json", filename]), signal)).rejects.toMatchObject({ code: "INVALID_IMAGE_DESCRIPTOR" });
    await expect(descriptors(parse(["send", ...Array.from({ length: 11 }, () => ["--image-json", filename]).flat()]), signal)).rejects.toMatchObject({ code: "USAGE" });
    await writeFile(filename, JSON.stringify({ ...f.image, byteLength: IMAGE_MAX_BYTES }));
    await expect(descriptors(parse(["send", ...Array.from({ length: 6 }, () => ["--image-json", filename]).flat()]), signal)).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
  });

  it("accepts saved successful image-upload/image-get JSON without shell extraction", async () => {
    const f = await fixture(); const filename = join(f.root, "descriptor.json");
    for (const command of ["image-upload", "image-get"]) {
      await writeFile(filename, JSON.stringify({ version: 1, ok: true, command, data: { image: f.image } }));
      expect(await descriptors(parse(["send", "--image-json", filename]), signal)).toEqual([f.image]);
    }
    await writeFile(filename, JSON.stringify({ version: 1, ok: false, command: "image-upload", data: { image: f.image } }));
    await expect(descriptors(parse(["send", "--image-json", filename]), signal)).rejects.toMatchObject({ code: "INVALID_IMAGE_DESCRIPTOR" });
  });

  it("refuses shared or repeated stdin input before reading it", async () => {
    await expect(descriptors(parse(["send", "--image-json", "-", "--image-json", "-"]), signal)).rejects.toMatchObject({ code: "USAGE" });
    await expect(descriptors(parse(["send", "--image-json", "-", "--text-file", "-"]), signal)).rejects.toMatchObject({ code: "USAGE" });
  });
});

async function fixture(bytes = png, mediaType: ImageDescriptor["mediaType"] = "image/png") {
  const root = await mkdtemp(join(tmpdir(), "leo-cli-images-test-"));
  directories.push(root);
  const input = join(root, "input.data"), output = join(root, "output.data");
  await writeFile(input, bytes);
  const image: ImageDescriptor = { imageId: randomUUID(), sessionId: session.sessionId, runtimeNodeId: runtime.runtimeNodeId, bindingRevision: 1, sha256: imageSha256(bytes), byteLength: bytes.length, mediaType };
  let receivedBytes = 0;
  const images = {
    limits: { query: vi.fn(async () => ({ maximumImageBytes: IMAGE_MAX_BYTES, maximumChunkBytes: IMAGE_MAX_CHUNK_BYTES, maximumImagesPerCommand: 10, maximumSessionBytes: IMAGE_MAX_BYTES * 10, maximumRuntimeBytes: IMAGE_MAX_BYTES * 100, mediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] })) },
    beginUpload: { mutate: vi.fn(async () => ({ imageId: image.imageId, byteLength: image.byteLength, receivedBytes, committed: null })) },
    writeUpload: { mutate: vi.fn(async (request: { offset: number; dataBase64: string }) => {
      expect(request.offset).toBe(receivedBytes);
      const chunk = Buffer.from(request.dataBase64, "base64");
      expect(chunk.equals(bytes.subarray(receivedBytes, receivedBytes + chunk.length))).toBe(true);
      receivedBytes += chunk.length;
      return { imageId: image.imageId, byteLength: image.byteLength, receivedBytes, committed: null };
    }) },
    commitUpload: { mutate: vi.fn(async () => image) },
    abortUpload: { mutate: vi.fn(async () => ({ imageId: image.imageId, aborted: true })) },
    resolvePath: { mutate: vi.fn(async () => image) },
    read: { query: vi.fn(async (request: { offset: number; length: number }) => {
      const chunk = bytes.subarray(request.offset, request.offset + request.length);
      return { image, offset: request.offset, dataBase64: chunk.toString("base64"), eof: request.offset + chunk.length === bytes.length };
    }) },
  };
  return { root, input, output, image, images, client: { images } as unknown as AccessClient };
}

describe("agent CLI image transfers", () => {
  it.each([
    ["image/png", png], ["image/jpeg", Buffer.from([255, 216, 255, 224, 1])],
    ["image/gif", Buffer.from("GIF89afixture")], ["image/webp", Buffer.from("RIFF0000WEBPfixture")],
  ] as const)("uploads %s from its signature with the caller's stable ID and exact target", async (mediaType, bytes) => {
    const f = await fixture(bytes, mediaType);
    const args = parse(["image-upload", session.sessionId, "--file", f.input, "--image-id", f.image.imageId]);
    expect(await imageCommand(args, f.client, session, runtime, signal)).toEqual({ image: f.image });
    expect(f.images.beginUpload.mutate).toHaveBeenCalledWith({ ...target, imageId: f.image.imageId, byteLength: bytes.length, sha256: imageSha256(bytes), mediaType });
    expect(f.images.commitUpload.mutate).toHaveBeenCalledWith({ ...target, imageId: f.image.imageId });
  });

  it("replays an interrupted upload using the same image ID and acknowledged bytes", async () => {
    const f = await fixture();
    const args = parse(["image-upload", session.sessionId, "--file", f.input, "--image-id", f.image.imageId]);
    f.images.commitUpload.mutate.mockRejectedValueOnce(new Error("reply lost"));
    await expect(imageCommand(args, f.client, session, runtime, signal)).rejects.toThrow("reply lost");
    expect(await imageCommand(args, f.client, session, runtime, signal)).toEqual({ image: f.image });
    expect(f.images.writeUpload.mutate).toHaveBeenCalledTimes(1);
    expect(f.images.beginUpload.mutate.mock.calls[0]).toEqual(f.images.beginUpload.mutate.mock.calls[1]);
  });

  it.each([Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), Buffer.from("text, not an image"), Buffer.alloc(0)])("rejects SVG/non-image/empty input without contacting the runtime", async bytes => {
    const f = await fixture(bytes);
    await expect(imageCommand(parse(["image-upload", session.sessionId, "--file", f.input, "--image-id", f.image.imageId]), f.client, session, runtime, signal)).rejects.toThrow();
    expect(f.images.limits.query).not.toHaveBeenCalled();
  });

  it("rejects oversized files, symlinks, and directories without remote mutations", async () => {
    const f = await fixture();
    const run = (path: string) => imageCommand(parse(["image-upload", session.sessionId, "--file", path, "--image-id", f.image.imageId]), f.client, session, runtime, signal);
    await truncate(f.input, IMAGE_MAX_BYTES + 1);
    await expect(run(f.input)).rejects.toMatchObject({ code: "INVALID_IMAGE_FILE" });
    const link = join(f.root, "link"); await symlink(f.input, link);
    await expect(run(link)).rejects.toMatchObject({ code: "ELOOP" });
    await expect(run(f.root)).rejects.toMatchObject({ code: "INVALID_IMAGE_FILE" });
    expect(f.images.limits.query).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed caller image IDs before contacting the runtime", async () => {
    const f = await fixture();
    for (const ids of [[], ["--image-id", "bad-id"]]) {
      await expect(imageCommand(parse(["image-upload", session.sessionId, "--file", f.input, ...ids]), f.client, session, runtime, signal)).rejects.toMatchObject({ code: "USAGE" });
    }
    expect(f.images.limits.query).not.toHaveBeenCalled();
  });

  it("downloads a descriptor by a bounded read and writes verified private bytes", async () => {
    const f = await fixture();
    expect(await imageCommand(parse(["image-get", session.sessionId, "--image-id", f.image.imageId, "--output", f.output]), f.client, session, runtime, signal)).toEqual({ image: f.image, output: f.output });
    expect(f.images.read.query).toHaveBeenNthCalledWith(1, { ...target, imageId: f.image.imageId, offset: 0, length: 1 }, { signal });
    expect(await readFile(f.output)).toEqual(png);
    expect((await lstat(f.output)).mode & 0o777).toBe(0o600);
  });

  it("downloads runtime SVG bytes without rendering and uses a stable scoped snapshot key", async () => {
    const bytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>untrusted()</script></svg>");
    const f = await fixture(bytes, "image/svg+xml");
    const args = parse(["image-get", session.sessionId, "--path", "output/diagram.svg", "--output", f.output]);
    expect(await imageCommand(args, f.client, session, runtime, signal)).toEqual({ image: f.image, output: f.output });
    expect(await readFile(f.output)).toEqual(bytes);
    await rm(f.output);
    await imageCommand(args, f.client, session, runtime, signal);
    expect(f.images.resolvePath.mutate.mock.calls[0]).toEqual(f.images.resolvePath.mutate.mock.calls[1]);
    expect(f.images.resolvePath.mutate).toHaveBeenCalledWith({ ...target, path: "output/diagram.svg", sourceKey: expect.stringMatching(/^leo-cli:path:[a-f0-9]{64}$/) }, { signal });
  });

  it("allows an explicit occurrence source key to request a new immutable path snapshot", async () => {
    const f = await fixture();
    await imageCommand(parse(["image-get", session.sessionId, "--path", "out.png", "--output", f.output]), f.client, session, runtime, signal);
    await rm(f.output);
    await imageCommand(parse(["image-get", session.sessionId, "--path", "out.png", "--source-key", "turn-two-plot", "--output", f.output]), f.client, session, runtime, signal);
    expect(f.images.resolvePath.mutate.mock.calls[0]).not.toEqual(f.images.resolvePath.mutate.mock.calls[1]);
  });

  it("rejects invalid source key usage before resolving a snapshot", async () => {
    const f = await fixture();
    for (const selector of [["--path", "out.png", "--source-key", ""], ["--path", "out.png", "--source-key", "x".repeat(4097)], ["--image-id", f.image.imageId, "--source-key", "unused"]]) {
      await expect(imageCommand(parse(["image-get", session.sessionId, ...selector, "--output", f.output]), f.client, session, runtime, signal)).rejects.toMatchObject({ code: "USAGE" });
    }
    expect(f.images.resolvePath.mutate).not.toHaveBeenCalled();
    expect(f.images.read.query).not.toHaveBeenCalled();
  });

  it("uploads and reads multiple bounded chunks without changing image identity", async () => {
    const bytes = Buffer.concat([png, Buffer.alloc(IMAGE_MAX_CHUNK_BYTES * 2)]);
    const f = await fixture(bytes);
    await imageCommand(parse(["image-upload", session.sessionId, "--file", f.input, "--image-id", f.image.imageId]), f.client, session, runtime, signal);
    expect(f.images.writeUpload.mutate).toHaveBeenCalledTimes(3);
    await imageCommand(parse(["image-get", session.sessionId, "--image-id", f.image.imageId, "--output", f.output]), f.client, session, runtime, signal);
    expect(f.images.read.query).toHaveBeenCalledTimes(4);
    expect(await readFile(f.output)).toEqual(bytes);
  });

  it.each(["https://example.test/image.png", "data:image/png;base64,abc", "file:///tmp/image.png", "//example.test/image.png", "foo\0bar"])("rejects external or malformed path %s locally", async path => {
    const f = await fixture();
    await expect(imageCommand(parse(["image-get", session.sessionId, "--path", path, "--output", f.output]), f.client, session, runtime, signal)).rejects.toMatchObject({ code: "INVALID_IMAGE_PATH" });
    expect(f.images.resolvePath.mutate).not.toHaveBeenCalled();
  });

  it("requires exactly one input selector and a file output", async () => {
    const f = await fixture();
    for (const options of [[], ["--path", "out.png", "--image-id", f.image.imageId], ["--path", "out.png", "--output", "-"]]) {
      await expect(imageCommand(parse(["image-get", session.sessionId, ...options]), f.client, session, runtime, signal)).rejects.toMatchObject({ code: "USAGE" });
    }
    expect(f.images.read.query).not.toHaveBeenCalled();
    expect(f.images.resolvePath.mutate).not.toHaveBeenCalled();
  });

  it("does not overwrite files, directories, or symlinks and does not resolve before that check", async () => {
    const f = await fixture();
    const link = join(f.root, "link"), directory = join(f.root, "directory");
    await symlink(f.input, link); await mkdir(directory);
    for (const output of [f.input, link, directory]) {
      await expect(imageCommand(parse(["image-get", session.sessionId, "--path", "out.png", "--output", output]), f.client, session, runtime, signal)).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    }
    expect(await readFile(f.input)).toEqual(png);
    expect(f.images.resolvePath.mutate).not.toHaveBeenCalled();
  });

  it("refuses a destination created while the download is in flight", async () => {
    const f = await fixture();
    f.images.resolvePath.mutate.mockImplementationOnce(async () => { await writeFile(f.output, "other writer"); return f.image; });
    await expect(imageCommand(parse(["image-get", session.sessionId, "--path", "out.png", "--output", f.output]), f.client, session, runtime, signal)).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    expect(await readFile(f.output, "utf8")).toBe("other writer");
  });

  it.each(["imageId", "sessionId", "runtimeNodeId", "bindingRevision"] as const)("rejects a descriptor with mismatched %s", async key => {
    const f = await fixture();
    const requestedImageId = f.image.imageId;
    Object.assign(f.image, { [key]: key === "bindingRevision" ? 2 : randomUUID() });
    await expect(imageCommand(parse(["image-get", session.sessionId, "--image-id", requestedImageId, "--output", f.output]), f.client, session, runtime, signal)).rejects.toThrow();
    await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not expose a file when the image checksum fails", async () => {
    const f = await fixture(); f.image.sha256 = "0".repeat(64);
    await expect(imageCommand(parse(["image-get", session.sessionId, "--image-id", f.image.imageId, "--output", f.output]), f.client, session, runtime, signal)).rejects.toThrow("checksum");
    await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops an aborted transfer before any request or output write", async () => {
    const f = await fixture();
    const abort = new AbortController(); abort.abort();
    await expect(imageCommand(parse(["image-get", session.sessionId, "--path", "out.png", "--output", f.output]), f.client, session, runtime, abort.signal)).rejects.toThrow();
    expect(f.images.resolvePath.mutate).not.toHaveBeenCalled();
    await expect(lstat(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
