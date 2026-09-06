import { randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AccessGatewayProjection } from "@arduano/agent-multiplex-gateway-core";
import { createAuthenticator } from "../apps/server/src/auth.js";
import { createPersonalHttpSurface } from "../apps/server/src/http.js";
import { createWorkCommandExecutor } from "../packages/work-commands/src/executor.js";
import { createWorkCommandHost, createWorkCommandsGateway } from "../packages/work-commands/src/transport.js";
import { createWorkCommandsHttpClient } from "../packages/work-commands/src/http-client.js";

it.skipIf(process.platform !== "linux")("executes once through the authenticated HTTP edge and real pinned work transport without any native agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "leo-work-complete-"));
  const closes: Array<() => Promise<void>> = [];
  try {
    const socket = createSocket("udp4");
    await new Promise<void>(resolve => socket.bind(0, "0.0.0.0", resolve));
    const port = socket.address().port;
    await new Promise<void>(resolve => socket.close(resolve));
    const executor = await createWorkCommandExecutor({ stateDirectory: join(directory, "host"), allowedRoots: [directory], platform: "wsl" });
    closes.push(() => executor.close());
    const sharedSecret = "disposable-integrated-work-transport-fixture";
    const host = await createWorkCommandHost({ stateDirectory: join(directory, "host"), sourceId: "work-wsl", name: "Work WSL", platform: "wsl", sharedSecret, enrollGateways: true, bindAddress: `0.0.0.0:${port}`, executor });
    closes.push(() => host.close());
    const gateway = await createWorkCommandsGateway({ stateDirectory: join(directory, "gateway"), sharedSecret, hosts: [host.pairing] });
    closes.push(() => gateway.close());
    const config = { mode: "tailscale" as const, publicOrigin: "http://100.64.0.1:8444", email: "fixture@example.test" };
    const surface = createPersonalHttpSurface(new AccessGatewayProjection([]), "fixture", config, createAuthenticator(config), undefined, gateway);
    closes.push(() => surface.close());
    await new Promise<void>(resolve => surface.server.listen(0, "127.0.0.1", resolve));
    const address = surface.server.address(); if (!address || typeof address === "string") throw new Error("Fixture address missing");
    const client = createWorkCommandsHttpClient({ origin: `http://127.0.0.1:${address.port}`, headers: () => ({ origin: config.publicOrigin, "tailscale-user-login": config.email }) });
    const [target] = await client.hosts();
    expect(target).toMatchObject({ sourceId: "work-wsl", available: true });
    const input = { target: { sourceId: target!.sourceId, endpointId: target!.endpointId }, request: { operationId: randomUUID(), cwd: directory, command: "printf 'once\\n' >> effects; printf 'fixture result'; printf 'fixture stderr' >&2; exit 7", timeoutMs: 5_000 } };
    await client.submit(input);
    const lookup = { target: input.target, operationId: input.request.operationId };
    await vi.waitFor(async () => expect(await client.get(lookup)).toMatchObject({ state: "completed", exitCode: 7, stdout: "fixture result", stderr: "fixture stderr" }), { timeout: 5_000 });
    expect(await client.submit(input)).toEqual(await client.get(lookup));
    expect(await readFile(join(directory, "effects"), "utf8")).toBe("once\n");
  } finally {
    for (const close of closes.reverse()) await close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
