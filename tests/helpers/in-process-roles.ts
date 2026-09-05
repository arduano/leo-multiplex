import { ControlNodeCoreError, type ControlNodeService, type RuntimeNodeConnection } from "@arduano/agent-multiplex-control-node-core";
import { GatewayRoutingError, type ControlNodeSourceClient } from "@arduano/agent-multiplex-gateway-core";
import type { RuntimeNodeBootId, RuntimeNodeId } from "@arduano/agent-multiplex-protocol";
import type { RuntimeNodeService } from "@arduano/agent-multiplex-runtime-node-core";

const unused = async (): Promise<never> => { throw new Error("This integration fixture does not implement the unused route"); };
const unusedImages = {
  beginImageUpload: unused, writeImageUpload: unused, commitImageUpload: unused,
  abortImageUpload: unused, resolveImagePath: unused, readImage: unused, imageLimits: unused,
};

async function knownConflict<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    // An in-process port has no tRPC error envelope. Preserve this known domain
    // rejection just as the production source client preserves a decoded CONFLICT.
    if (error instanceof ControlNodeCoreError && error.code === "CONFLICT") {
      throw new GatewayRoutingError("CONFLICT", error.message);
    }
    throw error;
  }
}

/** Real role services joined at their public ports; deliberately no sockets/native process. */
export function runtimeConnection(service: RuntimeNodeService, runtimeNodeId: RuntimeNodeId, runtimeNodeBootId: RuntimeNodeBootId): RuntimeNodeConnection {
  return {
    runtimeNodeId, runtimeNodeBootId, endpointId: "fixture-runtime-endpoint",
    refreshInventory: () => service.refreshInventory(),
    listModels: (harness) => service.models(harness),
    listLaunchProfiles: async () => service.listLaunchProfiles(),
    listLaunchProfileModels: (profile, harness) => service.listLaunchProfileModels(profile, harness),
    createLaunch: async (request) => service.createLaunch(request),
    getLaunch: async (id) => service.getLaunch(id) ?? null,
    listLaunches: async (query) => service.listLaunches(query),
    resume: (command) => service.resume(command),
    stop: (command) => service.stop(command),
    archive: async (request) => service.archive(request),
    getArchive: async (id) => service.getArchive(id),
    execute: (command) => service.execute(command),
    readNativeHistory: (id, request) => service.readNativeHistory(id, request),
    resolveInteraction: (input) => service.resolveInteraction(input),
    applyMetadata: async (operation) => service.applyMetadataSettlement(operation),
    getCommand: async (id) => service.getCommand(id),
    ...unusedImages,
  };
}

export function controlSource(service: ControlNodeService): ControlNodeSourceClient {
  return {
    loadSnapshot: async () => {
      const snapshot = service.sourceSnapshot();
      return { ...snapshot, manifest: snapshot.source.manifest, parentByControlNodeId: snapshot.source.parentByControlNodeId };
    },
    watch: (cursor, signal) => service.watchSessions({ sessions: "all", cursor, includeNative: true }, signal),
    listModels: (id, harness) => service.listModels(id, harness),
    listLaunchProfiles: async (query) => service.listLaunchProfiles(query),
    listLaunchModels: (id, profile, harness) => service.listLaunchProfileModels(id, profile, harness),
    createLaunch: (request) => service.createLaunch(request),
    getLaunch: (id) => service.getLaunch(id),
    listLaunches: (query) => service.listLaunches(query),
    searchSessions: (query) => service.searchSessions(query),
    getSession: (id) => service.getSession(id),
    refresh: (id) => service.refresh(id),
    resume: (command) => service.resume(command),
    stop: (command) => service.stop(command),
    archive: (request) => knownConflict(() => service.archive(request)),
    getArchive: (id) => service.getArchive(id),
    execute: (command) => service.execute(command),
    readNativeHistory: (id, request) => service.readNativeHistory(id, request),
    patchMetadata: (patch) => service.patchMetadata(patch),
    resolveInteraction: (input) => service.resolveInteraction(input),
    getCommand: async (id) => service.getCommand(id),
    detach: unused, forceDetach: unused, promote: unused,
    ...unusedImages,
  };
}
