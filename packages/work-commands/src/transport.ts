import { randomBytes } from "node:crypto";
import { link, lstat, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createP2PNode, createSharedSecretSecurity, type AuthorizationContext, type Peer, type PeerContext, type P2PNodeLimits } from "@arduano/p2prpc-core";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { privateDirectory, verifyPrivateTarget, writePrivateFile } from "../../../apps/host/src/private-state.js";
import {
  WORK_COMMAND_PROTOCOL, validateWorkHostPairings, workCommandIdSchema, workCommandLookupSchema, workCommandRecordSchema,
  workCommandRequestSchema, workCommandSubmitSchema, workHostPairingSchema,
  type WorkCommandExecutor, type WorkCommandsPort, type WorkHostPairing, type WorkHostTarget,
} from "./contract.js";

export { validateWorkHostPairings } from "./contract.js";

const endpointSchema = z.string().regex(/^[a-z2-7]{52}$/);
const t = initTRPC.context<PeerContext>().create();
const emptyRouter = t.router({});
const RPC_TIMEOUT_MS = 10_000;
const limits = {
  maxControlFrameBytes: 2 * 1_024 * 1_024, maxPeers: 16, maxPendingHandshakes: 4,
  maxQueuedOperations: 64, maxPeerQueuedOperations: 8, maxPrincipalQueuedOperations: 8,
  maxCallbacks: 64, maxPeerCallbacks: 8, maxPrincipalCallbacks: 8,
  connectTimeoutMs: 5_000, handshakeTimeoutMs: 5_000, shutdownTimeoutMs: 5_000,
} satisfies Partial<P2PNodeLimits>;

export class WorkCommandTransportError extends Error {
  constructor(readonly code: string) { super(code); this.name = "WorkCommandTransportError"; }
}

/** The namespace is separate from Multiplex. The pin, rather than shared-secret membership, grants execution. */
export function authorizeWorkHost(context: AuthorizationContext, gatewayEndpoint: string | undefined, enrollGateways: boolean): boolean {
  if (context.principal.id !== context.remotePeerId || context.action.kind !== "rpc") return false;
  const { path, type } = context.action;
  if (path === "enroll" && type === "mutation") {
    return gatewayEndpoint === context.remotePeerId || gatewayEndpoint === undefined && enrollGateways;
  }
  if (gatewayEndpoint !== context.remotePeerId) return false;
  return (path === "describe" || path === "get") && type === "query" ||
    (path === "submit" || path === "cancel") && type === "mutation";
}

async function readPrivate(path: string): Promise<string | undefined> {
  await verifyPrivateTarget(path);
  try {
    const info = await lstat(path);
    if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new WorkCommandTransportError("STATE_INVALID");
    return await readFile(path, "utf8");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** No-clobber publication keeps enrollment/identity immutable even across racing processes. */
async function createOnce(path: string, contents: string): Promise<string> {
  const candidate = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writePrivateFile(candidate, contents);
  try {
    try { await link(candidate, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(candidate).catch(() => undefined); }
  const value = await readPrivate(path);
  if (value === undefined) throw new WorkCommandTransportError("STATE_INVALID");
  return value;
}

async function identity(stateDirectory: string): Promise<Uint8Array> {
  if (!isAbsolute(stateDirectory)) throw new WorkCommandTransportError("STATE_INVALID");
  if (process.platform !== "win32") {
    for (let current = resolve(stateDirectory); ; current = dirname(current)) {
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0 ||
            current === resolve(stateDirectory) && ((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.())) throw new WorkCommandTransportError("STATE_INVALID");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (dirname(current) === current) break;
    }
  }
  await privateDirectory(stateDirectory);
  const path = join(stateDirectory, "endpoint.key");
  const stored = await readPrivate(path) ?? await createOnce(path, randomBytes(32).toString("hex") + "\n");
  if (!/^[a-f0-9]{64}\n?$/.test(stored)) throw new WorkCommandTransportError("STATE_INVALID");
  return Buffer.from(stored.trim(), "hex");
}

function executorFailure(error: unknown): never {
  const code = (error as { code?: unknown })?.code;
  const allowed = new Set(["BUSY", "CONFLICT", "REQUEST_CONFLICT", "RECOVERY_REQUIRED", "JOURNAL_FULL", "INVALID_INPUT", "INVALID_CWD", "CWD_NOT_ALLOWED", "OUTCOME_UNKNOWN", "CLOSED", "STATE_INVALID", "LIMIT_REACHED"]);
  throw new TRPCError({ code: "BAD_REQUEST", message: typeof code === "string" && allowed.has(code) ? code : "COMMAND_FAILED" });
}

function hostRouter(executor: WorkCommandExecutor, describe: () => Omit<WorkHostPairing, "locator">, enroll: (endpointId: string) => Promise<void>) {
  return t.router({
    enroll: t.procedure.input(z.object({}).strict()).mutation(async ({ ctx }) => {
      if (ctx.p2p.auth.principal.id !== ctx.p2p.peer.id) throw new TRPCError({ code: "FORBIDDEN" });
      await enroll(ctx.p2p.peer.id); return describe();
    }),
    describe: t.procedure.query(describe),
    submit: t.procedure.input(workCommandRequestSchema).output(workCommandRecordSchema).mutation(async ({ input }) => {
      try { return await executor.submit(input); } catch (error) { executorFailure(error); }
    }),
    get: t.procedure.input(workCommandIdSchema).output(workCommandRecordSchema.nullable()).query(async ({ input }) => {
      try { return await executor.get(input.operationId); } catch (error) { executorFailure(error); }
    }),
    cancel: t.procedure.input(workCommandIdSchema).output(workCommandRecordSchema.nullable()).mutation(async ({ input }) => {
      try { return await executor.cancel(input.operationId); } catch (error) { executorFailure(error); }
    }),
  });
}
type WorkHostRouter = ReturnType<typeof hostRouter>;

export async function createWorkCommandHost(options: {
  stateDirectory: string; sourceId: string; name: string; platform: "windows" | "wsl";
  sharedSecret: string; enrollGateways: boolean; bindAddress: string; executor: WorkCommandExecutor;
}): Promise<{ pairing: WorkHostPairing; close(): Promise<void> }> {
  const secretKey = await identity(options.stateDirectory);
  const binding = { sourceId: options.sourceId, platform: options.platform };
  const bindingPath = join(options.stateDirectory, "host-binding.json");
  const storedBinding = await readPrivate(bindingPath) ?? await createOnce(bindingPath, JSON.stringify(binding) + "\n");
  const expectedBinding = z.object({ sourceId: z.string(), platform: z.enum(["windows", "wsl"]) }).strict().parse(JSON.parse(storedBinding));
  if (expectedBinding.sourceId !== options.sourceId || expectedBinding.platform !== options.platform) throw new WorkCommandTransportError("IDENTITY_MISMATCH");
  const pinPath = join(options.stateDirectory, "gateway-peer.json");
  const pin = await readPrivate(pinPath);
  let gatewayEndpoint = pin === undefined ? undefined : endpointSchema.parse(JSON.parse(pin).endpointId);
  let nodeId = "";
  const describe = () => ({ sourceId: options.sourceId, name: options.name, platform: options.platform, endpointId: nodeId });
  const node = await createP2PNode({
    router: hostRouter(options.executor, describe, async (endpointId) => {
      if (gatewayEndpoint !== undefined && gatewayEndpoint !== endpointId || gatewayEndpoint === undefined && !options.enrollGateways) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ENROLLMENT_CLOSED" });
      }
      const committed = JSON.parse(await createOnce(pinPath, JSON.stringify({ endpointId }) + "\n"));
      gatewayEndpoint = endpointSchema.parse(committed.endpointId);
      if (gatewayEndpoint !== endpointId) throw new TRPCError({ code: "FORBIDDEN", message: "ENROLLMENT_CLOSED" });
    }),
    protocol: WORK_COMMAND_PROTOCOL, createContext: context => context,
    security: createSharedSecretSecurity(options.sharedSecret, { authorize: context => authorizeWorkHost(context, gatewayEndpoint, options.enrollGateways) }),
    preAuthorizePeer: peer => gatewayEndpoint === peer.id || gatewayEndpoint === undefined && options.enrollGateways,
    iroh: { secretKey, bindAddress: options.bindAddress, ticketTtlMs: 30 * 24 * 60 * 60_000, relay: { mode: "default" },
      allowAdvertisedAddress: () => true, allowDirectAddress: () => true, allowRelayUrl: () => true },
    limits, onError: () => undefined,
  });
  nodeId = node.id;
  try {
    const pairing = workHostPairingSchema.parse({ ...describe(), locator: { kind: "ticket", ticket: await node.createTicket() } });
    let closing: Promise<void> | undefined;
    return { pairing, close: () => closing ??= node.close() };
  } catch (error) { await node.close(); throw error; }
}


export async function createWorkCommandsGateway(options: {
  stateDirectory: string; sharedSecret: string; hosts: readonly WorkHostPairing[]; bindAddress?: string;
}): Promise<WorkCommandsPort & { close(): Promise<void> }> {
  const hosts = validateWorkHostPairings(options.hosts);
  const secretKey = await identity(options.stateDirectory);
  const endpoints = new Set(hosts.map(host => host.endpointId));
  const node = await createP2PNode({
    router: emptyRouter, protocol: WORK_COMMAND_PROTOCOL, createContext: context => context,
    security: createSharedSecretSecurity(options.sharedSecret, { authorize: () => false }),
    preAuthorizePeer: peer => endpoints.has(peer.id),
    iroh: { secretKey, ...(options.bindAddress === undefined ? {} : { bindAddress: options.bindAddress }), relay: { mode: "default" },
      allowDirectAddress: () => true, allowRelayUrl: () => true },
    limits, onError: () => undefined,
  });
  const connections = new Map<string, Promise<Peer<WorkHostRouter>>>();
  let closed = false;
  const connect = (host: WorkHostPairing): Promise<Peer<WorkHostRouter>> => {
    if (closed) throw new WorkCommandTransportError("UNAVAILABLE");
    let pending = connections.get(host.endpointId);
    if (!pending) {
      pending = (async () => {
        const peer = await node.connect<WorkHostRouter>({
          locator: host.locator, expectedPeerId: host.endpointId,
          expectedPrincipal: { id: host.endpointId, subject: host.endpointId, issuer: null, clientId: null, tenantId: null },
        });
        const description = await peer.rpc.enroll.mutate({}, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
        if (description.endpointId !== host.endpointId || description.sourceId !== host.sourceId || description.platform !== host.platform) {
          throw new WorkCommandTransportError("IDENTITY_MISMATCH");
        }
        return peer;
      })();
      connections.set(host.endpointId, pending);
      void pending.catch(() => connections.delete(host.endpointId));
    }
    return pending;
  };
  const select = (target: WorkHostTarget): WorkHostPairing => {
    const host = hosts.find(host => host.sourceId === target.sourceId && host.endpointId === target.endpointId);
    if (!host) throw new WorkCommandTransportError("HOST_NOT_CONFIGURED");
    return host;
  };
  const invoke = async <T>(target: WorkHostTarget, mutation: boolean, call: (peer: Peer<WorkHostRouter>) => Promise<T>): Promise<T> => {
    const host = select(target);
    let peer: Peer<WorkHostRouter>;
    try { peer = await connect(host); }
    catch { throw new WorkCommandTransportError("UNAVAILABLE"); }
    try { return await call(peer); }
    catch (error) {
      connections.delete(host.endpointId);
      // A definitive application rejection proves the operation was not accepted.
      const value = error as { data?: { code?: string }; message?: string };
      if (value.data?.code === "BAD_REQUEST" && value.message && /^[A-Z_]{1,40}$/.test(value.message)) throw new WorkCommandTransportError(value.message);
      if (value.data?.code === "FORBIDDEN" || value.data?.code === "UNAUTHORIZED") throw new WorkCommandTransportError("FORBIDDEN");
      throw new WorkCommandTransportError(mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE");
    }
  };
  let closing: Promise<void> | undefined;
  return {
    hosts: () => Promise.all(hosts.map(async host => {
      let available = false;
      try {
        const descriptor = await invoke(host, false, peer => peer.rpc.describe.query(undefined, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }));
        available = descriptor.endpointId === host.endpointId && descriptor.sourceId === host.sourceId && descriptor.platform === host.platform;
      } catch { /* Offline hosts remain visible with the exact configured identity. */ }
      return { sourceId: host.sourceId, endpointId: host.endpointId, name: host.name, platform: host.platform, available };
    })),
    submit: async inputValue => {
      const input = workCommandSubmitSchema.parse(inputValue);
      const record = workCommandRecordSchema.parse(await invoke(input.target, true, peer => peer.rpc.submit.mutate(input.request, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })));
      if (record.operationId !== input.request.operationId || record.cwd !== input.request.cwd || record.command !== input.request.command || record.timeoutMs !== input.request.timeoutMs) {
        throw new WorkCommandTransportError("OUTCOME_UNKNOWN");
      }
      return record;
    },
    get: async inputValue => {
      const input = workCommandLookupSchema.parse(inputValue);
      const record = workCommandRecordSchema.nullable().parse(await invoke(input.target, false, peer => peer.rpc.get.query({ operationId: input.operationId }, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })));
      if (record && record.operationId !== input.operationId) throw new WorkCommandTransportError("UNAVAILABLE");
      return record;
    },
    cancel: async inputValue => {
      const input = workCommandLookupSchema.parse(inputValue);
      const record = workCommandRecordSchema.nullable().parse(await invoke(input.target, true, peer => peer.rpc.cancel.mutate({ operationId: input.operationId }, { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) })));
      if (record && record.operationId !== input.operationId) throw new WorkCommandTransportError("OUTCOME_UNKNOWN");
      return record;
    },
    close: () => { closed = true; return closing ??= node.close(); },
  };
}
